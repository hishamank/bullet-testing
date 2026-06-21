/**
 * Typed errors for the agent layer. A single error class so callers (and the future tRPC
 * layer) can distinguish the agent's failure modes from unexpected runtime errors, mirroring
 * @bullet/db's `DbError`.
 */

/** Stable machine codes for the failure modes the agent pipeline raises. */
export type AgentErrorCode =
  | 'OLLAMA_HTTP' // a non-OK HTTP response from the Ollama server
  | 'OLLAMA_PARSE' // the model returned content that is not valid JSON
  | 'EXTRACTION_INVALID' // the model's JSON did not satisfy the extraction schema
  | 'NOT_FOUND' // a referenced row (e.g. the job's bullet) does not exist

/** A failure raised by the agent pipeline (Ollama transport, extraction parsing, …). */
export class AgentError extends Error {
  readonly code: AgentErrorCode
  /** Optional structured detail (e.g. a Zod error's flattened issues, or the raw content). */
  readonly details?: unknown

  constructor(code: AgentErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'AgentError'
    this.code = code
    this.details = details
  }
}
