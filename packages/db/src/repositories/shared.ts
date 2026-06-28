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

/**
 * The server-managed lifecycle fields a parsed INSERT carries OPTIONALLY (the client may omit
 * them; the server mints them). This is exactly the universal-field subset from
 * `@bullet/core/base.ts` (`ownedTimestampedStateInsertFields`) that every soft-deletable entity
 * leaves to the persistence layer to fill.
 */
interface InsertLifecycleDefaults {
  id?: string
  created_at?: number
  updated_at?: number
  state?: 'active' | 'deleted'
}

/**
 * Fill the server-managed lifecycle defaults (`id` / `created_at` / `updated_at` / `state`) on a
 * parsed INSERT object, returning the ready-to-persist row. `created_at` and `updated_at` share
 * one `now()` so a freshly-created row reads identical timestamps.
 *
 * This owns the default-minting that was copy-pasted across the soft-deletable repos, so the
 * universal-field convention's server defaults live in ONE place. The intersection return type
 * narrows the four lifecycle fields to non-optional while leaving every other parsed field
 * (already typed by the schema) untouched — so `db.insert(X).values(withInsertDefaults(parsed))`
 * stays fully typed. `createUser` opts out (the owner root has no `state`); see users.ts.
 */
export function withInsertDefaults<T extends InsertLifecycleDefaults>(
  parsed: T,
): T & Required<InsertLifecycleDefaults> {
  const ts = now()
  return {
    ...parsed,
    id: parsed.id ?? newId(),
    created_at: parsed.created_at ?? ts,
    updated_at: parsed.updated_at ?? ts,
    state: parsed.state ?? 'active',
  }
}

/** Common option for list queries: include soft-deleted rows (default false). */
export interface ListOptions {
  includeDeleted?: boolean
}
