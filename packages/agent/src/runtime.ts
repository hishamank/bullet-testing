/**
 * createAgentRuntime — the convenience factory that wires the brain together for the Task 4
 * server. Given `{ db, ollama, config }` it builds the typed emitter, the serial worker, and
 * bound helpers (enqueue, process, reprocess, weekly), so the server is a thin wrapper:
 *
 *   const agent = createAgentRuntime({ db, ollama, config })
 *   agent.worker.start()                       // begin draining the queue (single GPU slot)
 *   agent.enqueueExtraction(bulletId, ownerId) // on bullets.create
 *   agent.emitter.on('extraction:complete', …) // SSE source
 */

import type { Db } from '@bullet/db'
import type { AgentConfig } from './config'
import type { AgentDeps } from './deps'
import { type AgentEmitter, createAgentEmitter } from './events'
import type { OllamaClient } from './ollama/types'
import { enqueueExtraction } from './queue/enqueue'
import { type ProcessResult, processExtractJob } from './queue/process'
import { createExtractionWorker, type ExtractionWorker } from './queue/worker'
import { type ReconcileResult, reprocessBullet } from './reconcile/reconcile'
import { createWeeklyAnalyzer, type WeeklyAnalyzer } from './weekly/weekly'

/** What the caller provides to build a runtime (the emitter is created internally). */
export interface AgentRuntimeOptions {
  db: Db
  ollama: OllamaClient
  config: AgentConfig
  /** Optionally inject an emitter (e.g. to share one across runtimes); a fresh one by default. */
  emitter?: AgentEmitter
}

/** The wired-up agent runtime handed to the server. */
export interface AgentRuntime {
  /** The full deps bundle (db/ollama/config/emitter) — pass to any standalone pipeline fn. */
  deps: AgentDeps
  /** The typed event emitter (subscribe for SSE). */
  emitter: AgentEmitter
  /** The serial extraction worker (start/stop/drain). */
  worker: ExtractionWorker
  /** The weekly-analysis stub. */
  weekly: WeeklyAnalyzer
  /** Enqueue an extraction job for a freshly-created bullet. */
  enqueueExtraction(bulletId: string, ownerId: string): ReturnType<typeof enqueueExtraction>
  /** Process a specific job synchronously (rarely needed directly; the worker normally drives). */
  processExtractJob(job: Parameters<typeof processExtractJob>[1]): Promise<ProcessResult>
  /** Re-run extraction for an edited bullet, reconciling against applied entities (§4.7). */
  reprocessBullet(bulletId: string): Promise<ReconcileResult>
}

/** Wire the agent together for the server. */
export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  const emitter = options.emitter ?? createAgentEmitter()
  const deps: AgentDeps = {
    db: options.db,
    ollama: options.ollama,
    config: options.config,
    emitter,
  }

  const worker = createExtractionWorker(deps)
  const weekly = createWeeklyAnalyzer(deps)

  return {
    deps,
    emitter,
    worker,
    weekly,
    enqueueExtraction: (bulletId, ownerId) => enqueueExtraction(deps, bulletId, ownerId),
    processExtractJob: (job) => processExtractJob(deps, job),
    reprocessBullet: (bulletId) => reprocessBullet(deps, bulletId),
  }
}
