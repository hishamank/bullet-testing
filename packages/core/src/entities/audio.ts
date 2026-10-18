import { z } from 'zod'
import { ownedTimestampedStateFields } from '../base'
import { nonEmptyString, timestampMs, uuid } from '../primitives'

/**
 * Voice notes. A voice bullet keeps its AUDIO as the source of truth, permanently, on the phone
 * and on the server (soft delete only, like every row). Its text comes from transcripts:
 *
 *  - a `device_draft` — the live on-device transcript (Apple's on-device recognizer) saved at capture;
 *  - a `server` transcript — the home server's re-transcription (Whisper), which replaces the
 *    bullet text unless the user edited the draft (`bullet.text_edited_by_user`): then the user's
 *    text wins and the server transcript is only stored.
 *
 * Where the bytes live is side-specific and not part of the contract: the phone keeps a local file
 * path, the server a storage key.
 */

/** Largest accepted recording (~3h of AAC at 128 kbps). */
export const MAX_AUDIO_BYTES = 200 * 1024 * 1024

export const audioMimeTypeSchema = z
  .string()
  .regex(/^audio\/[a-z0-9.+-]+$/, 'an audio/* MIME type')
  .max(64)

/** 64 lowercase hex chars. */
export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'a SHA-256 hex digest')

/**
 * Upload progress, as the server sees it.
 *  - pending  — not all bytes have arrived yet (`received_bytes < size_bytes`).
 *  - uploaded — complete (and checksum-verified when a sha256 was given).
 */
export const audioUploadStatusSchema = z.enum(['pending', 'uploaded'])
export type AudioUploadStatus = z.infer<typeof audioUploadStatusSchema>

/** The metadata the phone declares for a recording (sent with `bullet.create`). */
export const audioMetadataFields = {
  id: uuid(),
  mime_type: audioMimeTypeSchema,
  duration_ms: z.number().int().nonnegative(),
  size_bytes: z.number().int().positive().max(MAX_AUDIO_BYTES),
  sha256: sha256Schema.nullable(),
} as const

export const audioAttachmentSelectSchema = z.object({
  ...ownedTimestampedStateFields,
  ...audioMetadataFields,
  bullet_id: uuid(),
  upload_status: audioUploadStatusSchema,
  received_bytes: z.number().int().nonnegative(),
})
export type AudioAttachment = z.infer<typeof audioAttachmentSelectSchema>

export const transcriptKindSchema = z.enum(['device_draft', 'server'])
export type TranscriptKind = z.infer<typeof transcriptKindSchema>

/**
 * Who produced a transcript. `languages` lists the languages detected (possibly several — the
 * user mixes English, Lebanese Arabic and French; empty when unknown). Codes are BCP-47 / ISO 639.
 */
export const transcriptSourceFields = {
  text: z.string(),
  engine: nonEmptyString(),
  model: z.string().nullable(),
  languages: z.array(z.string().min(2).max(35)),
} as const

export const transcriptSelectSchema = z.object({
  ...ownedTimestampedStateFields,
  ...transcriptSourceFields,
  bullet_id: uuid(),
  attachment_id: uuid(),
  kind: transcriptKindSchema,
  /** When the transcript was produced (device: at capture; server: when Whisper finished). */
  transcribed_at: timestampMs(),
})
export type Transcript = z.infer<typeof transcriptSelectSchema>
