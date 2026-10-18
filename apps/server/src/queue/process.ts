/**
 * Processing one claimed bullet: snapshot current state → ask the model (with a deadline) →
 * resolve → in ONE transaction, if the job is still current: reconcile suggestions, auto-apply,
 * set the bullet's final status and complete the job.
 */

import {
  type EngineConfig,
  type ExtractionSnapshot,
  extractCandidates,
  type LlmClient,
  resolveCandidates,
} from '@bullet/engine'
import { and, eq, inArray, isNull, ne, or } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { Db } from '../db/client'
import { bullets, tasks, trackers } from '../db/schema'
import { hasPendingSuggestions, reconcileSuggestions } from '../apply/reconcile'
import { touch } from '../sync/changes'
import { type BulletRow, type ClaimedJob, isJobCurrent, markJobDone } from './jobs'

export interface ProcessDeps {
  db: Db
  llm: LlmClient
  engine: EngineConfig
  now: () => number
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
  const { bullet } = claimed
  const snapshot = buildSnapshot(deps.db, bullet)
  const ctx = { capturedAt: bullet.captured_at, timezone: bullet.timezone }
  const candidates = await extractCandidates(
    { llm: deps.llm, config: deps.engine },
    { text: bullet.text, ...ctx },
    snapshot,
  )
  const { suggestions } = resolveCandidates(candidates, snapshot, deps.engine, ctx)

  const now = deps.now()
  return deps.db.transaction((tx) => {
    const current = isJobCurrent(tx, claimed)
    if (!current) return 'stale'
    reconcileSuggestions(tx, current, suggestions, now)
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
