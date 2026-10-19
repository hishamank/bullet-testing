/**
 * Processing one claimed bullet:
 *  1. voice bullets with a recording: transcribe it (with a deadline) and, in one transaction,
 *     store the server transcript and — unless the user edited the text — make it the bullet text;
 *  2. snapshot current state → split the capture into thoughts and extract things per thought
 *     (`processCapture`, with deadlines) → in ONE transaction, if the job is still current:
 *     reconcile thoughts, suggestions (auto-apply) and clarifying questions, set the final status.
 * A failure in either stage is recorded by the worker; a retry skips a finished transcription.
 * No usable transcript: the user's own text, else the phone draft (`text_from_draft`), else fail.
 */

import { randomUUID } from 'node:crypto'
import {
  type EngineConfig,
  EngineError,
  type ExtractionSnapshot,
  hasSpeech,
  isUsableDraft,
  type LlmClient,
  processCapture,
  type Transcriber,
  transcriptIsNoSpeech,
} from '@bullet/engine'
import { and, eq, inArray, isNull, ne, or } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { Db } from '../db/client'
import { bullets, tasks, thoughts, trackers, transcripts } from '../db/schema'
import type { AudioStore } from '../storage/audio-store'
import { hasPendingSuggestions, reconcileSuggestions } from '../apply/reconcile'
import { reconcileThoughts, replaceQuestions } from '../capture/thoughts'
import { touch } from '../sync/changes'
import { type BulletRow, type ClaimedJob, isJobCurrent, markJobDone, setBulletProc } from './jobs'

export interface ProcessDeps {
  db: Db
  llm: LlmClient
  engine: EngineConfig
  now: () => number
  /** Absent → voice bullets are processed on their device draft. */
  transcriber?: Transcriber
  audioStore?: AudioStore
}

/** A transcription failure retrying cannot fix: the recording is corrupt or holds no speech. */
const isPermanent = (err: unknown): err is EngineError =>
  err instanceof EngineError &&
  (err.code === 'TRANSCRIPTION_FAILED' || err.code === 'TRANSCRIPTION_NO_SPEECH')

/** The user mixes these; the transcriber auto-detects, the hints only bias it. */
const LANGUAGE_HINTS = ['en', 'ar', 'fr']

/** What stage 1 hands on: the bullet to extract from, or a finished outcome (nothing to redo). */
type StageResult = { bullet: BulletRow } | { done: ProcessOutcome } | null

/** The phone's live draft for a recording ('' when it had none). */
function deviceDraft(db: Db, attachmentId: string): string {
  return (
    db
      .select({ text: transcripts.text })
      .from(transcripts)
      .where(
        and(
          eq(transcripts.attachment_id, attachmentId),
          eq(transcripts.kind, 'device_draft'),
          eq(transcripts.state, 'active'),
        ),
      )
      .get()?.text ?? ''
  ).trim()
}

/**
 * Stage 1: transcribe the recording, then store the server transcript and (unless the user edited
 * the text) replace the bullet text. Returns the bullet to extract from, or null if stale.
 *
 * No usable transcript, for good (no speech, or audio that can't be read):
 *  - the user wrote the text down themselves → read their words at once;
 *  - else the phone's live draft has real content → it becomes the text (`text_from_draft`) and
 *    is read as usual. Whisper's silence phrases ("Thank you.") count as no speech here;
 *  - else the error stands: the bullet fails at once (decision 1).
 */
async function transcribeStage(deps: ProcessDeps, claimed: ClaimedJob): Promise<StageResult> {
  const t = claimed.transcribe
  if (!t || !deps.transcriber || !deps.audioStore) return { bullet: claimed.bullet }
  const draft = deviceDraft(deps.db, t.attachmentId)
  let result: Awaited<ReturnType<Transcriber['transcribe']>>
  try {
    const audio = deps.audioStore.read(t.storageKey)
    // Zero-length audio (stopped as soon as it started) has nothing to hear.
    if (audio.byteLength === 0 || t.durationMs === 0) {
      throw new EngineError('TRANSCRIPTION_NO_SPEECH', 'the recording is empty')
    }
    result = await deps.transcriber.transcribe({
      audio,
      mimeType: t.mimeType,
      languageHints: LANGUAGE_HINTS,
    })
    // Whatever the transcriber, a transcript with no words never becomes the capture's text, nor
    // does Whisper's "Thank you." over silence.
    if (!hasSpeech(result.text)) {
      throw new EngineError('TRANSCRIPTION_NO_SPEECH', 'no speech found in the recording')
    }
    if (transcriptIsNoSpeech(result.text, { durationMs: t.durationMs, draft })) {
      throw new EngineError(
        'TRANSCRIPTION_NO_SPEECH',
        `no speech found in the recording (only "${result.text.trim()}", a silence phrase)`,
      )
    }
  } catch (err) {
    if (!isPermanent(err)) throw err
    if (claimed.bullet.text_edited_by_user) return continueWithoutTranscript(deps, claimed, null)
    if (isUsableDraft(draft)) return continueWithoutTranscript(deps, claimed, draft)
    throw err
  }
  const now = deps.now()
  return deps.db.transaction((tx) => {
    const current = isJobCurrent(tx, claimed)
    if (!current) return null
    const id = randomUUID()
    tx.insert(transcripts)
      .values({
        id,
        owner_id: current.owner_id,
        bullet_id: current.id,
        attachment_id: t.attachmentId,
        kind: 'server',
        text: result.text,
        engine: result.engine,
        model: result.model,
        languages: result.languages,
        transcribed_at: now,
        created_at: now,
        updated_at: now,
      })
      .run()
    touch(tx, current.owner_id, 'transcripts', id)
    // The user's own words win over any transcript. A server-made text change is not an edit:
    // text_version stays, so this same job carries on to extraction (and reconciles what a
    // previous run on the phone's draft produced).
    const text = current.text_edited_by_user ? current.text : result.text
    const fromDraft = current.text_edited_by_user ? current.text_from_draft : false
    if (text !== current.text || fromDraft !== current.text_from_draft) {
      tx.update(bullets)
        .set({ text, text_from_draft: fromDraft, updated_at: now })
        .where(eq(bullets.id, current.id))
        .run()
    }
    setBulletProc(
      tx,
      current,
      {
        proc_status: 'processing',
        proc_error_code: current.proc_error_code,
        proc_error_message: current.proc_error_message,
        proc_next_retry_at: null,
      },
      now,
    )
    return {
      bullet: { ...current, text, text_from_draft: fromDraft, proc_status: 'processing' as const },
    }
  })
}

/**
 * Skip the transcript: the bullet goes on to `processing` with its own (user-written) text, or
 * with the phone's draft (`draft`), marked `text_from_draft`. A "Retry transcription" that again
 * found no speech leaves an already-processed draft capture as it was, without reading it again.
 */
function continueWithoutTranscript(
  deps: ProcessDeps,
  claimed: ClaimedJob,
  draft: string | null,
): StageResult {
  const now = deps.now()
  return deps.db.transaction((tx) => {
    const current = isJobCurrent(tx, claimed)
    if (!current) return null
    if (draft !== null) {
      const processedBefore =
        tx
          .select({ id: thoughts.id })
          .from(thoughts)
          .where(and(eq(thoughts.source_bullet_id, current.id), eq(thoughts.state, 'active')))
          .get() !== undefined
      if (current.text_from_draft && current.text === draft && processedBefore) {
        const status = hasPendingSuggestions(tx, current.id) ? 'needs_review' : 'processed'
        setBulletProc(
          tx,
          current,
          {
            proc_status: status,
            proc_error_code: null,
            proc_error_message: null,
            proc_next_retry_at: null,
          },
          now,
        )
        markJobDone(tx, current.id, now)
        return { done: status }
      }
      tx.update(bullets)
        .set({ text: draft, text_from_draft: true, updated_at: now })
        .where(eq(bullets.id, current.id))
        .run()
    }
    setBulletProc(
      tx,
      current,
      {
        proc_status: 'processing',
        proc_error_code: current.proc_error_code,
        proc_error_message: current.proc_error_message,
        proc_next_retry_at: null,
      },
      now,
    )
    const text = draft ?? current.text
    const fromDraft = draft !== null || current.text_from_draft
    return {
      bullet: { ...current, text, text_from_draft: fromDraft, proc_status: 'processing' as const },
    }
  })
}

/**
 * The state the model and resolver match against: active trackers and open tasks — excluding
 * whatever this same bullet produced, so re-processing an edit doesn't match its own output.
 */
export function buildSnapshot(db: Db, bullet: BulletRow): ExtractionSnapshot {
  const notFromThisBullet = (col: AnySQLiteColumn) => or(isNull(col), ne(col, bullet.id))
  return {
    trackers: db
      .select({
        id: trackers.id,
        name: trackers.name,
        input_type: trackers.input_type,
        config: trackers.config,
      })
      .from(trackers)
      .where(
        and(
          eq(trackers.owner_id, bullet.owner_id),
          eq(trackers.state, 'active'),
          notFromThisBullet(trackers.source_bullet_id),
        ),
      )
      .all(),
    openTasks: db
      .select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
        notes: tasks.notes,
        due_at: tasks.due_at,
        priority: tasks.priority,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.owner_id, bullet.owner_id),
          eq(tasks.state, 'active'),
          inArray(tasks.status, ['todo', 'in_progress']),
          notFromThisBullet(tasks.source_bullet_id),
        ),
      )
      .all() as ExtractionSnapshot['openTasks'],
  }
}

export type ProcessOutcome = 'processed' | 'needs_review' | 'stale'

/** Run extraction for a claimed job. Throws on model/engine failure (the worker records it). */
export async function processClaimedJob(
  deps: ProcessDeps,
  claimed: ClaimedJob,
): Promise<ProcessOutcome> {
  const stage = await transcribeStage(deps, claimed)
  if (!stage) return 'stale'
  if ('done' in stage) return stage.done
  const { bullet } = stage
  const snapshot = buildSnapshot(deps.db, bullet)
  const ctx = { capturedAt: bullet.captured_at, timezone: bullet.timezone }
  const outcome = await processCapture(
    { llm: deps.llm, config: deps.engine },
    { text: bullet.text, ...ctx },
    snapshot,
  )

  const now = deps.now()
  return deps.db.transaction((tx) => {
    const current = isJobCurrent(tx, claimed)
    if (!current) return 'stale'
    // capture → thoughts → things → questions, all in this one transaction.
    const thoughtIds = reconcileThoughts(tx, current, outcome.thoughts, now)
    const { ids } = reconcileSuggestions(
      tx,
      current,
      outcome.things.map((t) => ({ ...t, thoughtId: thoughtIds[t.thoughtPosition] ?? null })),
      now,
    )
    replaceQuestions(
      tx,
      current,
      outcome.questions.map((q) => ({
        ...q,
        thoughtId: thoughtIds[q.thoughtPosition] ?? null,
        suggestionId: q.thingIndex === null ? null : (ids[q.thingIndex] ?? null),
      })),
      now,
    )
    const status = hasPendingSuggestions(tx, current.id) ? 'needs_review' : 'processed'
    tx.update(bullets)
      .set({
        proc_status: status,
        proc_error_code: null,
        proc_error_message: null,
        proc_next_retry_at: null,
        proc_updated_at: now,
        updated_at: now,
      })
      .where(eq(bullets.id, current.id))
      .run()
    touch(tx, current.owner_id, 'bullets', current.id)
    markJobDone(tx, current.id, now)
    return status
  })
}
