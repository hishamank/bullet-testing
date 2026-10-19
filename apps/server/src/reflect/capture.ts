/**
 * A reflective question from a capture (origin `capture`). When a capture's extraction is done,
 * in the same transaction, {@link afterCaptureProcessed} queues a `reflect` job if the capture
 * may get one. The worker runs reflect jobs only when no extraction job is ready (lower
 * priority), so a capture's things never wait on a question. The job reads the capture's worries,
 * self-questions and ideas, asks the model (`reflectOnThoughts`), re-checks the limits and the
 * capture in one transaction, and stores at most one question.
 *
 * A capture may get one when: it is active; it does not itself answer a reflective question; it
 * has no reflective question already (one per capture: "Not this one", Later and answers all
 * keep theirs active, so they survive re-processing; only a question withdrawn because an edit
 * reworded its thought frees the capture for a new one); none of its thoughts is sensitive; and it has a worry,
 * self-question or idea not marked `never_ask`.
 *
 * A failed model call is retried a few times, then dropped quietly: the capture is unaffected.
 */

import type { ReflectableThought } from '@bullet/engine'
import { type EngineConfig, isReflectable, type LlmClient, reflectOnThoughts } from '@bullet/engine'
import { and, asc, eq, inArray, lte } from 'drizzle-orm'
import type { Db } from '../db/client'
import { bullets, questions, reflectJobs, thoughts } from '../db/schema'
import { type BulletRow, DEFAULT_RETRY_POLICY, type RetryPolicy, retryDelay } from '../queue/jobs'
import { createReflectiveQuestion, refusalNow, withdrawLiveReflective } from './questions'
import { askDeferredConnectionQuestion, queueLinkJob } from '../connections/link-job'

export type ReflectJobRow = typeof reflectJobs.$inferSelect

/** Attempts per reflect job before it is dropped (it is optional; the capture is done). */
export const REFLECT_MAX_ATTEMPTS = 3

function activeThoughts(db: Db, bulletId: string) {
  return db
    .select()
    .from(thoughts)
    .where(and(eq(thoughts.source_bullet_id, bulletId), eq(thoughts.state, 'active')))
    .orderBy(asc(thoughts.position))
    .all()
}

/** The thoughts the question may be about, or null when the capture may not get one at all. */
export function reflectableThoughts(db: Db, bullet: BulletRow): ReflectableThought[] | null {
  if (bullet.state !== 'active') return null
  if (bullet.answers_question_id !== null) {
    const answered = db
      .select({ kind: questions.kind })
      .from(questions)
      .where(eq(questions.id, bullet.answers_question_id))
      .get()
    if (answered?.kind === 'reflective') return null
  }
  const before = db
    .select({ id: questions.id })
    .from(questions)
    .where(
      and(
        eq(questions.source_bullet_id, bullet.id),
        eq(questions.kind, 'reflective'),
        // One per capture, whichever asked it: its own reflection or a connection question.
        inArray(questions.origin, ['capture', 'connection']),
        // A question withdrawn because an edit reworded its thought (`deleted`) doesn't count:
        // the new wording may get one. Dismissed and answered ones stay active, so they do.
        eq(questions.state, 'active'),
      ),
    )
    .get()
  if (before) return null
  const all = activeThoughts(db, bullet.id)
  if (all.some((t) => t.sensitive)) return null
  const usable = all
    .filter((t) => isReflectable(t.kind) && !t.never_ask)
    .map((t) => ({ position: t.position, kind: t.kind, text: t.text }))
  return usable.length > 0 ? usable : null
}

/**
 * Called in the transaction that stores a capture's processing result:
 *  - a reflective question about a thought that is gone (edited away) is withdrawn, and so is
 *    every live one about the capture once it reads as distress;
 *  - a reflect job is queued (or replaced) when the capture may get a question.
 */
export function afterCaptureProcessed(db: Db, bullet: BulletRow, now: number): void {
  const all = db
    .select({ id: thoughts.id, state: thoughts.state, sensitive: thoughts.sensitive })
    .from(thoughts)
    .where(eq(thoughts.source_bullet_id, bullet.id))
    .all()
  for (const t of all.filter((x) => x.state !== 'active')) {
    withdrawLiveReflective(db, bullet.owner_id, eq(questions.source_thought_id, t.id), now)
  }
  if (all.some((t) => t.state === 'active' && t.sensitive)) {
    withdrawLiveReflective(db, bullet.owner_id, eq(questions.source_bullet_id, bullet.id), now)
  }
  // Links (slice 3) run next, before the reflect job; they never wait on it.
  queueLinkJob(db, bullet, now)
  if (reflectableThoughts(db, bullet) === null) {
    cancelReflectJob(db, bullet.id, now)
    return
  }
  db.insert(reflectJobs)
    .values({
      bullet_id: bullet.id,
      owner_id: bullet.owner_id,
      status: 'queued',
      attempts: 0,
      text_version: bullet.text_version,
      run_after: now,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: reflectJobs.bullet_id,
      set: {
        status: 'queued',
        attempts: 0,
        text_version: bullet.text_version,
        run_after: now,
        locked_at: null,
        last_error: null,
        updated_at: now,
      },
    })
    .run()
}

/** Stop a capture's reflect job (it was deleted, or may no longer get a question). */
export function cancelReflectJob(db: Db, bulletId: string, now: number): void {
  db.update(reflectJobs)
    .set({ status: 'cancelled', updated_at: now })
    .where(and(eq(reflectJobs.bullet_id, bulletId), eq(reflectJobs.status, 'queued')))
    .run()
}

export interface ClaimedReflectJob {
  job: ReflectJobRow
  bullet: BulletRow
}

/** Claim the oldest ready reflect job whose capture text is still the one it was queued for. */
export function claimNextReflectJob(db: Db, now: number): ClaimedReflectJob | null {
  return db.transaction((tx) => {
    for (;;) {
      const job = tx
        .select()
        .from(reflectJobs)
        .where(and(eq(reflectJobs.status, 'queued'), lte(reflectJobs.run_after, now)))
        .orderBy(asc(reflectJobs.run_after), asc(reflectJobs.created_at))
        .limit(1)
        .get()
      if (!job) return null
      const bullet = tx.select().from(bullets).where(eq(bullets.id, job.bullet_id)).get()
      if (!bullet || bullet.state !== 'active' || bullet.text_version !== job.text_version) {
        // Deleted or edited since: the edit's own processing queues a fresh job.
        tx.update(reflectJobs)
          .set({ status: 'cancelled', updated_at: now })
          .where(eq(reflectJobs.bullet_id, job.bullet_id))
          .run()
        continue
      }
      const claimed = {
        ...job,
        status: 'running' as const,
        attempts: job.attempts + 1,
        locked_at: now,
      }
      tx.update(reflectJobs)
        .set({ status: 'running', attempts: claimed.attempts, locked_at: now, updated_at: now })
        .where(eq(reflectJobs.bullet_id, job.bullet_id))
        .run()
      return { job: claimed, bullet }
    }
  })
}

function isReflectJobCurrent(db: Db, claimed: ClaimedReflectJob): BulletRow | null {
  const job = db
    .select()
    .from(reflectJobs)
    .where(eq(reflectJobs.bullet_id, claimed.job.bullet_id))
    .get()
  const bullet = db.select().from(bullets).where(eq(bullets.id, claimed.job.bullet_id)).get()
  if (!job || !bullet || bullet.state !== 'active') return null
  if (job.status !== 'running' || job.locked_at !== claimed.job.locked_at) return null
  if (job.text_version !== bullet.text_version) return null
  return bullet
}

function finishReflectJob(db: Db, bulletId: string, now: number): void {
  db.update(reflectJobs)
    .set({ status: 'done', locked_at: null, last_error: null, updated_at: now })
    .where(eq(reflectJobs.bullet_id, bulletId))
    .run()
}

export type ReflectOutcome = 'asked' | 'none' | 'capped' | 'stale'

export interface ReflectDeps {
  db: Db
  llm: LlmClient
  engine: EngineConfig
  now: () => number
}

/**
 * Run one claimed reflect job. Throws only when the model call fails (the worker records it with
 * {@link markReflectJobFailed}).
 */
export async function runReflectJob(
  deps: ReflectDeps,
  claimed: ClaimedReflectJob,
): Promise<ReflectOutcome> {
  const { db } = deps
  const ownerId = claimed.bullet.owner_id
  const thoughtsBefore = reflectableThoughts(db, claimed.bullet)
  // Nothing to ask about any more, or the limits are reached: no model call at all.
  if (thoughtsBefore === null || refusalNow(db, ownerId, 'capture', deps.now()) !== null) {
    db.transaction((tx) => {
      finishReflectJob(tx, claimed.bullet.id, deps.now())
      askDeferredConnectionQuestion(tx, claimed.bullet.id, deps.now())
    })
    return thoughtsBefore === null ? 'none' : 'capped'
  }
  const draft = await reflectOnThoughts({ llm: deps.llm, config: deps.engine }, thoughtsBefore)
  const now = deps.now()
  return db.transaction((tx): ReflectOutcome => {
    const bullet = isReflectJobCurrent(tx, claimed)
    if (!bullet) return 'stale'
    finishReflectJob(tx, bullet.id, now)
    // No question of its own: a connection question held back by the link job may take the slot.
    const noneOfItsOwn = (outcome: ReflectOutcome): ReflectOutcome => {
      askDeferredConnectionQuestion(tx, bullet.id, now)
      return outcome
    }
    if (!draft) return noneOfItsOwn('none')
    // Re-check everything: the user may have acted, or another question arrived, meanwhile.
    const usable = reflectableThoughts(tx, bullet)
    if (!usable?.some((t) => t.position === draft.thoughtPosition)) return noneOfItsOwn('none')
    if (refusalNow(tx, ownerId, 'capture', now) !== null) return noneOfItsOwn('capped')
    const thought = tx
      .select({ id: thoughts.id })
      .from(thoughts)
      .where(
        and(
          eq(thoughts.source_bullet_id, bullet.id),
          eq(thoughts.state, 'active'),
          eq(thoughts.position, draft.thoughtPosition),
        ),
      )
      .get()
    createReflectiveQuestion(
      tx,
      {
        ownerId,
        origin: 'capture',
        text: draft.text,
        sourceBulletId: bullet.id,
        sourceThoughtId: thought?.id ?? null,
      },
      now,
    )
    return 'asked'
  })
}

/** A failed model call: try again later with backoff, or drop the job quietly. */
export function markReflectJobFailed(
  db: Db,
  claimed: ClaimedReflectJob,
  err: unknown,
  now: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): 'retry' | 'failed' | 'stale' {
  return db.transaction((tx) => {
    if (!isReflectJobCurrent(tx, claimed)) return 'stale'
    const giveUp = claimed.job.attempts >= Math.min(REFLECT_MAX_ATTEMPTS, policy.maxAttempts)
    tx.update(reflectJobs)
      .set({
        status: giveUp ? 'failed' : 'queued',
        run_after: giveUp ? claimed.job.run_after : now + retryDelay(claimed.job.attempts, policy),
        locked_at: null,
        last_error: err instanceof Error ? err.message : String(err),
        updated_at: now,
      })
      .where(eq(reflectJobs.bullet_id, claimed.job.bullet_id))
      .run()
    if (giveUp) askDeferredConnectionQuestion(tx, claimed.job.bullet_id, now)
    return giveUp ? 'failed' : 'retry'
  })
}

/** Startup: reflect jobs left `running` by a crash go back in the queue. Returns how many. */
export function recoverStuckReflectJobs(db: Db, now: number): number {
  return db
    .update(reflectJobs)
    .set({ status: 'queued', locked_at: null, run_after: now, updated_at: now })
    .where(eq(reflectJobs.status, 'running'))
    .run().changes
}
