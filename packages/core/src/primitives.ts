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

/**
 * An IANA time zone name ("Europe/Paris", "America/Argentina/Buenos_Aires", "UTC"). Validated by
 * shape only — runtimes disagree on which zones they know, and a zone unknown to one side must not
 * make a capture unsyncable. The engine falls back to UTC for a zone it cannot resolve.
 */
export const ianaTimezone = () =>
  z
    .string()
    .min(1)
    .max(64)
    .regex(/^(?:UTC|GMT|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){1,2})$/, 'IANA time zone')
