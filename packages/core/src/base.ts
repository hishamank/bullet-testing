import { z } from 'zod'
import { recordStateSchema } from './enums'
import { timestampMs, uuid } from './primitives'

/**
 * The universal field convention, encoded ONCE so entities compose it rather than
 * copy-pasting `id` / `owner_id` / `created_at` / `updated_at` / `state` everywhere.
 *
 * See CLAUDE.md → "Universal data conventions (every persisted entity)".
 *
 * These are plain object literals (raw shapes), not `z.object(...)`, so they can be spread
 * into both SELECT and INSERT object shapes and selectively overridden (e.g. made optional
 * on insert).
 */

/** Server-managed lifecycle fields present on every persisted, owned entity. */
export const ownedTimestampedStateFields = {
  id: uuid(),
  owner_id: uuid(),
  created_at: timestampMs(),
  updated_at: timestampMs(),
  state: recordStateSchema,
} as const

/**
 * The same lifecycle fields with the server-managed subset made OPTIONAL — the variant
 * used to build INSERT schemas. The client supplies `owner_id`; the server mints
 * `id`/`created_at`/`updated_at` and defaults `state`.
 */
export const ownedTimestampedStateInsertFields = {
  id: uuid().optional(),
  owner_id: uuid(),
  created_at: timestampMs().optional(),
  updated_at: timestampMs().optional(),
  state: recordStateSchema.optional(),
} as const

/**
 * Provenance: the bullet this entity was extracted from. Nullable — null for
 * manually-created entities (CLAUDE.md "Provenance"). Bullets themselves omit this field.
 */
export const sourceBulletIdNullable = {
  source_bullet_id: uuid().nullable(),
} as const

/** Provenance for a Suggestion: ALWAYS derived from a bullet, so non-null. */
export const sourceBulletIdRequired = {
  source_bullet_id: uuid(),
} as const

/** Convenience: a tiny standalone schema for the lifecycle fields (rarely needed directly). */
export const ownedTimestampedStateSchema = z.object(ownedTimestampedStateFields)
