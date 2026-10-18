/**
 * The durable processing queue. One job row per bullet, persisted in SQLite, so a restart loses
 * nothing: queued jobs wait, and jobs left `running` by a crash are recovered at startup.
 *
 * Every job transition also moves the bullet's processing status (the state the phone shows),
 * in the same transaction.
 */

import type { ProcessingErrorCode } from '@bullet/core'
import { EngineError } from '@bullet/engine'
import { and, asc, eq, lte } from 'drizzle-orm'
import type { Db } from '../db/client'
import { bullets, jobs } from '../db/schema'
import { touch } from '../sync/changes'

export type BulletRow = typeof bullets.$inferSelect
export type JobRow = typeof jobs.$inferSelect

export interface RetryPolicy {
  /** Total attempts per run before a bullet is marked `failed`. */
  maxAttempts: number
  /** Delay before retry n (1-based) is `baseDelayMs * factor^(n-1)`, capped at `maxDelayMs`. */
  baseDelayMs: number
  factor: number
  maxDelayMs: number
}

/** ~10s, 1m, 6m, 15m: rides out a llama-server restart without hammering it. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 10_000,
  factor: 6,
  maxDelayMs: 15 * 60_000,
}

export function retryDelay(attempt: number, policy: RetryPolicy): number {
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * policy.factor ** (attempt - 1))
}

type BulletProc = Pick<
  BulletRow,
  'proc_status' | 'proc_error_code' | 'proc_error_message' | 'proc_next_retry_at'
> & { proc_attempts?: number }

function setBulletProc(
  db: Db,
  bullet: Pick<BulletRow, 'id' | 'owner_id'>,
  p: BulletProc,
  now: number,
) {
  db.update(bullets)
    .set({ ...p, proc_updated_at: now, updated_at: now })
    .where(eq(bullets.id, bullet.id))
    .run()
  touch(db, bullet.owner_id, 'bullets', bullet.id)
}

/**
 * (Re)queue a bullet for processing on its current text — on capture, edit and user retry. Resets
 * the run's attempt counter; the bullet shows `synced`.
 */
export function enqueue(db: Db, bullet: BulletRow, now: number): void {
  db.insert(jobs)
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
      target: jobs.bullet_id,
      set: {
        status: 'queued',
        attempts: 0,
        text_version: bullet.text_version,
        run_after: now,
        locked_at: null,
        last_error_code: null,
        last_error_message: null,
        updated_at: now,
      },
    })
    .run()
  setBulletProc(
    db,
    bullet,
    {
      proc_status: 'synced',
      proc_error_code: null,
      proc_error_message: null,
      proc_next_retry_at: null,
    },
    now,
  )
}

/** Stop processing a bullet (it was deleted). A running job's result will be discarded. */
export function cancelJob(db: Db, bulletId: string, now: number): void {
  db.update(jobs)
    .set({ status: 'cancelled', updated_at: now })
    .where(eq(jobs.bullet_id, bulletId))
    .run()
}

export interface ClaimedJob {
  job: JobRow
  bullet: BulletRow
}

/** Claim the oldest ready job: job → running, bullet → processing, attempts + 1. */
export function claimNextJob(db: Db, now: number): ClaimedJob | null {
  return db.transaction((tx) => {
    const ready = () =>
      tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.status, 'queued'), lte(jobs.run_after, now)))
        .orderBy(asc(jobs.run_after), asc(jobs.created_at))
        .limit(1)
        .get()
    let job = ready()
    let bullet = job && tx.select().from(bullets).where(eq(bullets.id, job.bullet_id)).get()
    // Defensive: a job whose bullet is gone is cancelled and the next one is tried.
    while (job && (!bullet || bullet.state !== 'active')) {
      tx.update(jobs)
        .set({ status: 'cancelled', updated_at: now })
        .where(eq(jobs.bullet_id, job.bullet_id))
        .run()
      job = ready()
      bullet = job && tx.select().from(bullets).where(eq(bullets.id, job.bullet_id)).get()
    }
    if (!job || !bullet) return null
    const claimed = {
      ...job,
      status: 'running' as const,
      attempts: job.attempts + 1,
      locked_at: now,
    }
    tx.update(jobs)
      .set({ status: 'running', attempts: claimed.attempts, locked_at: now, updated_at: now })
      .where(eq(jobs.bullet_id, job.bullet_id))
      .run()
    const attempts = bullet.proc_attempts + 1
    setBulletProc(
      tx,
      bullet,
      {
        proc_status: 'processing',
        proc_attempts: attempts,
        proc_error_code: bullet.proc_error_code,
        proc_error_message: bullet.proc_error_message,
        proc_next_retry_at: null,
      },
      now,
    )
    return {
      job: claimed,
      bullet: { ...bullet, proc_status: 'processing', proc_attempts: attempts },
    }
  })
}

/**
 * Is this claimed job still the live one for its bullet? False when the bullet was edited (newer
 * text), deleted, or the job was cancelled/re-queued while the model was thinking — the result
 * must then be thrown away.
 */
export function isJobCurrent(db: Db, claimed: ClaimedJob): BulletRow | null {
  const job = db.select().from(jobs).where(eq(jobs.bullet_id, claimed.job.bullet_id)).get()
  const bullet = db.select().from(bullets).where(eq(bullets.id, claimed.job.bullet_id)).get()
  if (!job || !bullet) return null
  if (job.status !== 'running' || job.locked_at !== claimed.job.locked_at) return null
  if (job.text_version !== claimed.job.text_version || bullet.text_version !== job.text_version) {
    return null
  }
  if (bullet.state !== 'active') return null
  return bullet
}

export function markJobDone(db: Db, bulletId: string, now: number): void {
  db.update(jobs)
    .set({
      status: 'done',
      locked_at: null,
      last_error_code: null,
      last_error_message: null,
      updated_at: now,
    })
    .where(eq(jobs.bullet_id, bulletId))
    .run()
}

/** Map any thrown error to the contract's processing error code. */
export function classifyError(err: unknown): { code: ProcessingErrorCode; message: string } {
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof EngineError) {
    switch (err.code) {
      case 'LLM_HTTP':
        return { code: 'llm_unavailable', message }
      case 'LLM_TIMEOUT':
        return { code: 'llm_timeout', message }
      case 'LLM_PARSE':
      case 'EXTRACTION_INVALID':
        return { code: 'llm_bad_output', message }
    }
  }
  return { code: 'internal', message }
}

/**
 * Record a failed attempt: schedule an automatic retry with backoff (bullet back to `synced`,
 * error + next_retry_at visible), or — out of attempts — mark it `failed`. A stale job (bullet
 * edited/deleted meanwhile) is ignored.
 */
export function markJobFailed(
  db: Db,
  claimed: ClaimedJob,
  err: unknown,
  now: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): 'retry' | 'failed' | 'stale' {
  return db.transaction((tx) => {
    const bullet = isJobCurrent(tx, claimed)
    if (!bullet) return 'stale'
    const { code, message } = classifyError(err)
    const giveUp = claimed.job.attempts >= policy.maxAttempts
    const runAfter = now + retryDelay(claimed.job.attempts, policy)
    tx.update(jobs)
      .set({
        status: giveUp ? 'failed' : 'queued',
        run_after: giveUp ? claimed.job.run_after : runAfter,
        locked_at: null,
        last_error_code: code,
        last_error_message: message,
        updated_at: now,
      })
      .where(eq(jobs.bullet_id, bullet.id))
      .run()
    setBulletProc(
      tx,
      bullet,
      {
        proc_status: giveUp ? 'failed' : 'synced',
        proc_error_code: code,
        proc_error_message: message,
        proc_next_retry_at: giveUp ? null : runAfter,
      },
      now,
    )
    return giveUp ? 'failed' : 'retry'
  })
}

/**
 * Startup recovery: a job still `running` belongs to a process that died mid-call. Put it back in
 * the queue (its attempt already counts) or fail it if it had none left. Returns how many.
 */
export function recoverStuckJobs(
  db: Db,
  now: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): number {
  return db.transaction((tx) => {
    const stuck = tx.select().from(jobs).where(eq(jobs.status, 'running')).all()
    for (const job of stuck) {
      const bullet = tx.select().from(bullets).where(eq(bullets.id, job.bullet_id)).get()
      const giveUp = job.attempts >= policy.maxAttempts
      tx.update(jobs)
        .set({
          status: giveUp ? 'failed' : 'queued',
          run_after: now,
          locked_at: null,
          last_error_code: 'internal',
          last_error_message: 'interrupted by a server restart',
          updated_at: now,
        })
        .where(eq(jobs.bullet_id, job.bullet_id))
        .run()
      if (bullet && bullet.state === 'active') {
        setBulletProc(
          tx,
          bullet,
          {
            proc_status: giveUp ? 'failed' : 'synced',
            proc_error_code: 'internal',
            proc_error_message: 'interrupted by a server restart',
            proc_next_retry_at: null,
          },
          now,
        )
      }
    }
    return stuck.length
  })
}
