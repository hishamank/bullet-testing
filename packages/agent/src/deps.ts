/**
 * The dependency bundle threaded through the whole agent pipeline.
 *
 * EVERY agent function takes `deps` as its first parameter (dependency injection): the DB
 * connection, the Ollama client (an interface — mocked in tests), the resolved config, and the
 * typed event emitter. Nothing in the pipeline reaches for a global, opens its own DB, or reads
 * `process.env`, so the entire brain is testable with `createTestDb()` + a scripted Ollama
 * client.
 */

import type { Db } from '@bullet/db'
import type { AgentConfig } from './config'
import type { AgentEmitter } from './events'
import type { OllamaClient } from './ollama/types'

export interface AgentDeps {
  /** The Drizzle DB handle (or a transaction handle) — the ONLY way to touch the database. */
  db: Db
  /** The Ollama client interface (HttpOllamaClient in prod, a scripted fake in tests). */
  ollama: OllamaClient
  /** Resolved agent configuration (models + tier thresholds). */
  config: AgentConfig
  /** The typed event emitter the worker publishes lifecycle events on (SSE source for Task 4). */
  emitter: AgentEmitter
}
