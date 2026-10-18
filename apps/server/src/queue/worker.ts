/**
 * The processing worker: the single consumer of the queue. Strictly one job at a time (one GPU,
 * one model slot). Every LLM call runs under a deadline, and every failure is recorded on the job
 * and the bullet — the loop itself never throws.
 */

import { type EngineConfig, type LlmClient, withLlmTimeout } from '@bullet/engine'
import type { Db } from '../db/client'
import { claimNextJob, DEFAULT_RETRY_POLICY, markJobFailed, type RetryPolicy } from './jobs'
import { processClaimedJob } from './process'

export interface WorkerOptions {
  db: Db
  llm: LlmClient
  engine: EngineConfig
  now?: () => number
  /** Deadline for one model call (the extraction may make two: initial + repair). */
  llmTimeoutMs?: number
  retry?: RetryPolicy
  /** Called with each unexpected error, for logging. */
  onError?: (err: unknown) => void
}

export interface Worker {
  /** Poll every `intervalMs` until stopped. Idempotent. */
  start(intervalMs?: number): void
  stop(): void
  /** Wake the loop now (after a push) instead of waiting for the next tick. */
  kick(): void
  /** Process every job that is ready now, one by one; resolves with how many ran. */
  drain(): Promise<number>
}

export function createWorker(opts: WorkerOptions): Worker {
  const now = opts.now ?? Date.now
  const deps = {
    db: opts.db,
    llm: withLlmTimeout(opts.llm, opts.llmTimeoutMs ?? 120_000),
    engine: opts.engine,
    now,
  }
  let timer: ReturnType<typeof setInterval> | undefined
  let busy: Promise<number> | null = null

  async function runOne(): Promise<boolean> {
    const claimed = claimNextJob(opts.db, now())
    if (!claimed) return false
    try {
      await processClaimedJob(deps, claimed)
    } catch (err) {
      try {
        markJobFailed(opts.db, claimed, err, now(), opts.retry ?? DEFAULT_RETRY_POLICY)
      } catch (inner) {
        opts.onError?.(inner)
      }
      opts.onError?.(err)
    }
    return true
  }

  function drain(): Promise<number> {
    // Serialize: a drain requested while one runs waits for it, then runs again.
    const run = async () => {
      let n = 0
      try {
        while (await runOne()) n += 1
      } catch (err) {
        // e.g. the database is locked or gone; the next tick tries again.
        opts.onError?.(err)
      }
      return n
    }
    const next = (busy ?? Promise.resolve(0)).then(run, run)
    busy = next
    void next.finally(() => {
      if (busy === next) busy = null
    })
    return next
  }

  return {
    start(intervalMs = 1000) {
      if (timer) return
      timer = setInterval(() => void (busy ? undefined : drain()), intervalMs)
      timer.unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
    },
    kick() {
      if (!busy) void drain()
    },
    drain,
  }
}
