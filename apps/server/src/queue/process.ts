/**
 * Processing one claimed bullet:
 *  1. voice bullets with a recording: transcribe it (with a deadline) and, in one transaction,
 *     store the server transcript and — unless the user edited the text — make it the bullet text;
 *  2. snapshot current state → split the capture into thoughts and extract things per thought
 *     (`processCapture`, with deadlines) → in ONE transaction, if the job is still current:
 *     reconcile thoughts, suggestions (auto-apply) and clarifying questions, set the final status.
 * A failure in either stage is recorded by the worker; a retry skips a finished transcription.
 */

import { randomUUID } from 'node:crypto'
import {
  type EngineConfig,
  type ExtractionSnapshot,
  type LlmClient,
  processCapture,
  type Transcriber,
} from '@bullet/engine'
import { and, eq, inArray, isNull, ne, or } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { Db } from '../db/client'
import { bullets, tasks, trackers, transcripts } from '../db/schema'
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

/** The user mixes these; the transcriber auto-detects, the hints only bias it. */
const LANGUAGE_HINTS = ['en', 'ar', 'fr']

/**
 * Stage 1: transcribe the recording, then store the server transcript and (unless the user edited
 * the text) replace the bullet text. Returns the bullet to extract from, or null if stale.
 */
async function transcribeStage(deps: ProcessDeps, claimed: ClaimedJob): Promise<BulletRow | null> {
  const t = claimed.transcribe
  if (!t || !deps.transcriber || !deps.audioStore) return claimed.bullet
  const result = await deps.transcriber.transcribe({
    audio: deps.audioStore.read(t.storageKey),
    mimeType: t.mimeType,
    languageHints: LANGUAGE_HINTS,
  })
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
    // text_version stays, so this same job carries on to extraction.
    const text = current.text_edited_by_user ? current.text : result.text
    if (text !== current.text) {
      tx.update(bullets).set({ text, updated_at: now }).where(eq(bullets.id, current.id)).run()
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
    return { ...current, text, proc_status: 'processing' as const }
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
  const bullet = await transcribeStage(deps, claimed)
  if (!bullet) return 'stale'
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
