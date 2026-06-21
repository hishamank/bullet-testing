/**
 * Jobs repository — the serial queue for the future worker. Jobs have a `status` lifecycle
 * (`queued → running → done | failed`) instead of a soft-delete `state`.
 */

import { and, asc, eq } from 'drizzle-orm'
import type { Db } from '../client'
import type { JobPayload, JobStatus, JobType } from '../jobs'
import { jobs } from '../schema'
import { newId, now } from './shared'

/** The persisted job row (the SELECT shape). */
export interface Job {
  id: string
  owner_id: string | null
  type: JobType
  payload: JobPayload
  status: JobStatus
  attempts: number
  error: string | null
  created_at: number
  updated_at: number
  started_at: number | null
  finished_at: number | null
}

export interface EnqueueJobInput {
  type: JobType
  payload: JobPayload
  owner_id?: string | null
}

/** Add a job to the queue in `queued` status. */
export function enqueueJob(db: Db, input: EnqueueJobInput): Job {
  const ts = now()
  const row: Job = {
    id: newId(),
    owner_id: input.owner_id ?? null,
    type: input.type,
    payload: input.payload,
    status: 'queued',
    attempts: 0,
    error: null,
    created_at: ts,
    updated_at: ts,
    started_at: null,
    finished_at: null,
  }
  db.insert(jobs).values(row).run()
  return row
}

export function getJobById(db: Db, id: string): Job | undefined {
  return db.select().from(jobs).where(eq(jobs.id, id)).get()
}

/** List jobs in a given status, oldest first. */
export function listJobsByStatus(db: Db, status: JobStatus): Job[] {
  return db.select().from(jobs).where(eq(jobs.status, status)).orderBy(asc(jobs.created_at)).all()
}

/**
 * Claim the oldest queued job, transitioning it `queued → running` (bumps `attempts`, stamps
 * `started_at`). Returns the claimed job, or `undefined` if the queue is empty. Designed for
 * a single serial worker; the read-then-write is fine under SQLite's single-writer model.
 */
export function claimNextJob(db: Db): Job | undefined {
  const next = db
    .select()
    .from(jobs)
    .where(eq(jobs.status, 'queued'))
    .orderBy(asc(jobs.created_at))
    .get()
  if (!next) return undefined
  const ts = now()
  db.update(jobs)
    .set({ status: 'running', attempts: next.attempts + 1, started_at: ts, updated_at: ts })
    .where(and(eq(jobs.id, next.id), eq(jobs.status, 'queued')))
    .run()
  return getJobById(db, next.id)
}

/** Mark a running (or any) job done, stamping `finished_at` and clearing any prior error. */
export function markJobDone(db: Db, id: string): Job | undefined {
  const ts = now()
  db.update(jobs)
    .set({ status: 'done', error: null, finished_at: ts, updated_at: ts })
    .where(eq(jobs.id, id))
    .run()
  return getJobById(db, id)
}

/** Mark a job failed with an error message, stamping `finished_at`. */
export function markJobFailed(db: Db, id: string, error: string): Job | undefined {
  const ts = now()
  db.update(jobs)
    .set({ status: 'failed', error, finished_at: ts, updated_at: ts })
    .where(eq(jobs.id, id))
    .run()
  return getJobById(db, id)
}
