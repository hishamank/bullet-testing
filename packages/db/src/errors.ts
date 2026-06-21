/**
 * Typed errors for the db layer. A single error class so callers (and the future tRPC layer)
 * can distinguish guard/validation failures from unexpected runtime errors.
 */

/** Stable machine codes for the failure modes the apply/commit engine guards against. */
export type DbErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'INVALID_PAYLOAD'
  | 'UNSUPPORTED_OPERATION'
  | 'CONSTRAINT'

/** A guard or validation failure raised by the repositories or the apply/commit engine. */
export class DbError extends Error {
  readonly code: DbErrorCode
  /** Optional structured detail (e.g. a Zod error's flattened issues). */
  readonly details?: unknown

  constructor(code: DbErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'DbError'
    this.code = code
    this.details = details
  }
}
