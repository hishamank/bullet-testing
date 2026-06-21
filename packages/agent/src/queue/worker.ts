/**
 * The serial inference worker — the SOLE consumer of `extract_bullet` jobs, so concurrency is
 * strictly 1 (a single GPU slot: only one model inference runs at a time). It drains the
 * @bullet/db jobs queue: `claimNextJob` → `processExtractJob` → `markJobDone` / `markJobFailed`.
 *
 * Two drive modes:
 *   - `start(intervalMs)` / `stop()` — a polling loop for production (re-entrancy guarded so a
 *     slow job never overlaps the next tick).
 *   - `drain()` — process all currently-queued jobs then resolve (for tests / one-shot flush).
 *
 * On a processing error the job is `markJobFailed(error)` and 'extraction:error' is emitted; the
 * loop SURVIVES (never crashes), so one bad bullet does not wedge the queue.
 */

import { claimNextJob, markJobDone, markJobFailed } from '@bullet/db'
import type { AgentDeps } from '../deps'
import { processExtractJob } from './process'

/** The job type the worker consumes. */
export const EXTRACT_BULLET_JOB: 'extract_bullet' = 'extract_bullet'

export interface ExtractionWorker {
  /** Start polling every `intervalMs` (default 250ms). Idempotent. */
  start(intervalMs?: number): void
  /** Stop polling. Idempotent. In-flight work is allowed to finish. */
  stop(): void
  /** Process every currently-queued job, then resolve. Returns the number processed. */
  drain(): Promise<number>
  /** True while the polling loop is active. */
  readonly running: boolean
}

/**
 * Create the serial extraction worker. It claims ONE job at a time (single GPU slot) and is the
 * only consumer of the queue.
 */
export function createExtractionWorker(deps: AgentDeps): ExtractionWorker {
  let timer: ReturnType<typeof setInterval> | undefined
  // Re-entrancy guard: a tick that finds work in-flight does nothing (strict serial execution).
  let busy = false

  /** Claim and process the next job, if any. Returns true if a job was handled. */
  async function processNext(): Promise<boolean> {
    const job = claimNextJob(deps.db)
    if (!job) return false

    // Only `extract_bullet` jobs are ours; mark anything else failed so it does not loop forever.
    if (job.type !== EXTRACT_BULLET_JOB) {
      markJobFailed(deps.db, job.id, `worker does not handle job type '${job.type}'`)
      deps.emitter.emit('extraction:error', {
        jobId: job.id,
        bulletId: null,
        error: `unhandled job type '${job.type}'`,
      })
      return true
    }

    try {
      await processExtractJob(deps, job)
      markJobDone(deps.db, job.id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      markJobFailed(deps.db, job.id, message)
      // Best-effort bulletId for the error event (the payload itself may have been the problem).
      const rawBulletId = job.payload?.bulletId
      const bulletId = typeof rawBulletId === 'string' ? rawBulletId : null
      deps.emitter.emit('extraction:error', { jobId: job.id, bulletId, error: message })
    }
    return true
  }

  /** One polling tick: process a single job unless one is already in flight. */
  async function tick(): Promise<void> {
    if (busy) return
    busy = true
    try {
      await processNext()
    } finally {
      busy = false
    }
  }

  return {
    get running() {
      return timer !== undefined
    },

    start(intervalMs = 250) {
      if (timer) return
      timer = setInterval(() => {
        // Fire-and-forget; errors are handled inside processNext, so this never rejects.
        void tick()
      }, intervalMs)
      // Do not keep the process alive solely for the poller (server controls lifetime).
      if (typeof timer === 'object' && 'unref' in timer) {
        ;(timer as { unref: () => void }).unref()
      }
    },

    stop() {
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }
    },

    async drain() {
      let count = 0
      // Process strictly one at a time until the queue is empty.
      while (await processNext()) {
        count += 1
      }
      return count
    },
  }
}
