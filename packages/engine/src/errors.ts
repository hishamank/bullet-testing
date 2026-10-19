/**
 * Typed errors for the engine, so callers can tell its failure modes apart from unexpected
 * runtime errors.
 */

/** Stable machine codes for the failure modes the engine raises. */
export type EngineErrorCode =
  | 'LLM_HTTP' // the LLM call failed (transport, non-OK response, scripted client exhausted)
  | 'LLM_TIMEOUT' // the LLM did not answer within the deadline
  | 'TRANSCRIBER_HTTP' // the speech-to-text engine is unreachable / answered with an error
  | 'TRANSCRIBER_TIMEOUT' // transcription did not finish within the deadline
  | 'TRANSCRIPTION_FAILED' // the recording could not be decoded (corrupt / unsupported audio)
  | 'TRANSCRIPTION_NO_SPEECH' // the recording was read but holds no speech (silence, a tone)
  | 'LLM_PARSE' // the model returned content that is not valid JSON
  | 'EXTRACTION_INVALID' // the model's JSON did not satisfy the extraction schema

export class EngineError extends Error {
  readonly code: EngineErrorCode
  /** Optional structured detail (e.g. a Zod error's flattened issues, or the raw content). */
  readonly details?: unknown

  constructor(code: EngineErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'EngineError'
    this.code = code
    this.details = details
  }
}
