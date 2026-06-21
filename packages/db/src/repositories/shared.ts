/**
 * Shared helpers for the repositories: id/timestamp minting and a uniform "parse insert input
 * with a @bullet/core schema, throwing a typed DbError on failure" wrapper.
 */

import { DbError } from '../errors'

/** Mint a fresh UUID v4 (per the locked decision: `crypto.randomUUID()`). */
export const newId = (): string => crypto.randomUUID()

/** The current time as epoch milliseconds — the canonical timestamp representation. */
export const now = (): number => Date.now()

/**
 * A structural view of a Zod-like schema's `safeParse`. We depend on @bullet/core's exported
 * schemas (not on `zod` directly), so we describe just the shape we use — keeping `zod` out of
 * @bullet/db's dependency surface.
 */
export interface ParseableSchema<T> {
  safeParse(
    input: unknown,
  ): { success: true; data: T } | { success: false; error: { flatten(): unknown } }
}

/**
 * Parse `input` against a @bullet/core INSERT schema, throwing a typed `DbError` with the
 * flattened issues when it fails. Keeps validation behavior identical across repos.
 */
export function parseInsert<T>(schema: ParseableSchema<T>, input: unknown): T {
  const res = schema.safeParse(input)
  if (!res.success) {
    throw new DbError('INVALID_PAYLOAD', 'Insert input failed validation', res.error.flatten())
  }
  return res.data
}

/** Common option for list queries: include soft-deleted rows (default false). */
export interface ListOptions {
  includeDeleted?: boolean
}
