import { z } from 'zod'

/**
 * Shared primitive Zod builders that encode the project's locked field conventions
 * (see CLAUDE.md → "Universal data conventions" and the timestamp/ID decisions).
 *
 * These are factory functions so every field gets a fresh schema instance (avoids any
 * accidental shared-mutation surprises) and so the conventions live in exactly one place.
 */

/** A UUID string. Used for `id`, `owner_id`, and every foreign key. */
export const uuid = () => z.string().uuid()

/**
 * A timestamp: epoch **milliseconds** as a non-negative integer.
 * This is the canonical timestamp representation for the whole codebase — never a string.
 * Used for `created_at`, `updated_at`, `due_at`, `occurred_at`, `logged_at`, `resolved_at`, …
 */
export const timestampMs = () => z.number().int().nonnegative()

/** A required, non-empty (after no trimming — emptiness only) human string, e.g. a title. */
export const nonEmptyString = () => z.string().min(1)
