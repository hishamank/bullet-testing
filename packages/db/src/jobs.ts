/**
 * Job queue types — a db-only concern (not part of the @bullet/core domain). The serial
 * worker that drains this queue lives in @bullet/agent (a future task); @bullet/db only owns
 * the persistence and the lifecycle transitions.
 */

/** Job lifecycle status. Unlike domain rows, jobs have no soft-delete `state`. */
export type JobStatus = 'queued' | 'running' | 'done' | 'failed'

/**
 * The kind of work a job represents. Open-ended `string` so new job types can be added
 * without a migration; the v1 driver is bullet extraction.
 */
export type JobType = 'extract_bullet' | (string & {})

/** Arbitrary structured payload carried by a job (e.g. `{ bullet_id }` for extraction). */
export type JobPayload = Record<string, unknown>
