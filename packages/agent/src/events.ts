/**
 * The agent's typed event emitter. The serial worker publishes extraction lifecycle events so a
 * future tRPC/SSE server (Task 4) can stream them to the UI ("your bullet produced these
 * suggestions"). Exported as a type so the server can subscribe with full type-safety.
 *
 * Built on `node:events` EventEmitter but wrapped in a typed facade so `on`/`emit` are checked
 * against {@link AgentEvents}.
 */

import { EventEmitter } from 'node:events'

/** Payload emitted when a bullet's extraction job completes successfully. */
export interface ExtractionCompleteEvent {
  jobId: string
  bulletId: string
  /** Ids of every Suggestion persisted from this bullet. */
  suggestionIds: string[]
  /** Ids of the suggestions that were auto-applied (tier 'auto'). */
  appliedIds: string[]
  /**
   * Ids of 'auto'-tier suggestions whose auto-apply FAILED (e.g. the target was deleted between
   * persist and apply). These degrade to normal pending suggestions — the product behavior stays
   * fail-soft — but we SURFACE them here (instead of swallowing) so the server/SSE can observe it.
   * Empty on a clean run.
   */
  failedAutoApplyIds: string[]
}

/** Payload emitted when a bullet's extraction job fails. */
export interface ExtractionErrorEvent {
  jobId: string
  /** The bullet id if known (it may be missing/unreadable, which is itself a failure mode). */
  bulletId: string | null
  /** A human-readable error message. */
  error: string
}

/** The closed map of event name → payload type. */
export interface AgentEvents {
  'extraction:complete': ExtractionCompleteEvent
  'extraction:error': ExtractionErrorEvent
}

/**
 * A small typed emitter facade. Only the methods the agent + server need are exposed, each
 * constrained to {@link AgentEvents}.
 */
export interface AgentEmitter {
  on<K extends keyof AgentEvents>(event: K, listener: (payload: AgentEvents[K]) => void): this
  once<K extends keyof AgentEvents>(event: K, listener: (payload: AgentEvents[K]) => void): this
  off<K extends keyof AgentEvents>(event: K, listener: (payload: AgentEvents[K]) => void): this
  emit<K extends keyof AgentEvents>(event: K, payload: AgentEvents[K]): boolean
}

/** Create a fresh typed agent emitter. */
export function createAgentEmitter(): AgentEmitter {
  // The untyped EventEmitter is the substrate; the AgentEmitter interface is the typed surface.
  return new EventEmitter() as unknown as AgentEmitter
}
