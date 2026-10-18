import { z } from 'zod'
import { timestampMs } from './primitives'

/**
 * Bullet processing status — the state machine the UI shows next to every bullet
 * (docs/contract.md is the readable version; keep the two in sync).
 *
 *   saved_local ─push ack→ synced ─┬─(voice + audio)→ transcribing ─┐
 *                            ▲      └─(text)──────────────────────────┴→ processing ─┬→ processed
 *                            │                                     ├→ needs_review ─→ processed
 *                            │                                     └→ failed ─user retry→ synced
 *                            └── transient error / edit / crash recovery (from transcribing or
 *                                processing)
 *
 * `saved_local` exists ON THE PHONE ONLY: it means "stored on this device, not yet accepted by
 * the server". The server never stores or sends it; its first state is `synced`.
 *
 * `transcribing` happens only for voice bullets with recorded audio: the server re-transcribes
 * the audio (Whisper) before extraction. A voice bullet whose audio has not finished uploading
 * waits in `synced`.
 */
export const bulletProcessingStatusSchema = z.enum([
  'saved_local',
  'synced',
  'transcribing',
  'processing',
  'processed',
  'needs_review',
  'failed',
])
export type BulletProcessingStatus = z.infer<typeof bulletProcessingStatusSchema>

/** The subset the server stores and sends (everything except the phone-only `saved_local`). */
export const serverBulletProcessingStatusSchema = bulletProcessingStatusSchema.exclude([
  'saved_local',
])
export type ServerBulletProcessingStatus = z.infer<typeof serverBulletProcessingStatusSchema>

/**
 * Why processing failed. Every failure is retryable by the user; the server also retries the
 * transient ones automatically with backoff before giving up.
 *
 *  - llm_unavailable — the home server could not reach the model (llama-server down, HTTP error).
 *  - llm_timeout     — the model did not answer in time.
 *  - llm_bad_output  — the model answered with something unusable, even after a repair retry.
 *  - transcription_unavailable — the speech-to-text engine (whisper.cpp) is down/unreachable.
 *  - transcription_timeout     — transcription did not finish in time.
 *  - transcription_failed      — the engine could not transcribe the audio (corrupt/unsupported
 *                                audio, or no speech found).
 *  - internal        — any other server error.
 */
export const processingErrorCodeSchema = z.enum([
  'llm_unavailable',
  'llm_timeout',
  'llm_bad_output',
  'transcription_unavailable',
  'transcription_timeout',
  'transcription_failed',
  'internal',
])
export type ProcessingErrorCode = z.infer<typeof processingErrorCodeSchema>

export const processingErrorSchema = z.object({
  code: processingErrorCodeSchema,
  /** Human-readable detail for logs/debug screens. Not meant to be shown verbatim to users. */
  message: z.string(),
})
export type ProcessingError = z.infer<typeof processingErrorSchema>

/**
 * A bullet's processing state as it travels over sync.
 *
 *  - `attempts` counts processing attempts so far (the "retry count"); 0 before the first one.
 *  - `error` is the LAST error. Present when `failed`; may also be present on `synced` when an
 *    automatic retry is scheduled (the UI can show "retrying").
 *  - `next_retry_at` is set only while an automatic retry is scheduled.
 */
export const bulletProcessingSchema = z.object({
  status: bulletProcessingStatusSchema,
  attempts: z.number().int().nonnegative(),
  error: processingErrorSchema.nullable(),
  next_retry_at: timestampMs().nullable(),
  updated_at: timestampMs(),
})
export type BulletProcessing = z.infer<typeof bulletProcessingSchema>

/** Allowed status transitions. The phone may additionally overlay `saved_local` (see below). */
export const BULLET_STATUS_TRANSITIONS: Readonly<
  Record<BulletProcessingStatus, readonly BulletProcessingStatus[]>
> = {
  saved_local: ['synced'],
  synced: ['transcribing', 'processing'],
  transcribing: ['processing', 'failed', 'synced'],
  processing: ['processed', 'needs_review', 'failed', 'synced'],
  processed: ['synced'],
  needs_review: ['processed', 'synced'],
  failed: ['synced'],
}

export const canTransition = (from: BulletProcessingStatus, to: BulletProcessingStatus): boolean =>
  BULLET_STATUS_TRANSITIONS[from].includes(to)

/** Statuses after which nothing more happens on its own (the user may still act). */
export const isSettledStatus = (s: BulletProcessingStatus): boolean =>
  s === 'processed' || s === 'needs_review' || s === 'failed'

/**
 * The status the phone shows. A bullet with an unsent local change (capture, edit or retry still
 * in the outbox) shows `saved_local`, whatever the server last said; otherwise the server's status.
 */
export const displayStatus = (
  serverStatus: ServerBulletProcessingStatus | null,
  hasPendingLocalChange: boolean,
): BulletProcessingStatus =>
  hasPendingLocalChange || serverStatus === null ? 'saved_local' : serverStatus
