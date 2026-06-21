import { z } from 'zod'
import {
  ownedTimestampedStateFields,
  ownedTimestampedStateInsertFields,
  sourceBulletIdRequired,
} from './base'
import {
  suggestionOperationSchema,
  suggestionStatusSchema,
  suggestionTierSchema,
  targetKindSchema,
} from './enums'
import { timestampMs, uuid } from './primitives'

/**
 * Suggestion — the extraction envelope. Every agent extraction becomes a first-class,
 * persisted Suggestion the user confirms (see CLAUDE.md §4.3). Suggestions never auto-expire.
 *
 *  - `source_bullet_id` is NON-null: a suggestion always derives from a bullet.
 *  - `target_id` is null for `create`, set for `append`/`update`.
 *  - `payload` is a loosely-typed record here; it is validated against the target kind's
 *    INSERT schema via `validateSuggestionPayload` (see registry.ts).
 *  - `confidence` is 0..1 inclusive.
 */

/** Proposed fields. Validated structurally per `target_kind` by `validateSuggestionPayload`. */
export const suggestionPayloadSchema = z.record(z.string(), z.unknown())
export type SuggestionPayload = z.infer<typeof suggestionPayloadSchema>

/** Confidence in [0, 1] inclusive. */
export const confidenceSchema = z.number().min(0).max(1)

export const suggestionSelectSchema = z.object({
  ...ownedTimestampedStateFields,
  ...sourceBulletIdRequired,
  target_kind: targetKindSchema,
  operation: suggestionOperationSchema,
  target_id: uuid().nullable(),
  payload: suggestionPayloadSchema,
  confidence: confidenceSchema,
  tier: suggestionTierSchema,
  status: suggestionStatusSchema,
  resolved_at: timestampMs().nullable(),
})
export type Suggestion = z.infer<typeof suggestionSelectSchema>

export const suggestionInsertSchema = z.object({
  ...ownedTimestampedStateInsertFields,
  ...sourceBulletIdRequired,
  target_kind: targetKindSchema,
  operation: suggestionOperationSchema,
  target_id: uuid().nullable(),
  payload: suggestionPayloadSchema,
  confidence: confidenceSchema,
  tier: suggestionTierSchema,
  // `status` is server-defaultable on insert.
  status: suggestionStatusSchema.default('pending'),
  resolved_at: timestampMs().nullable(),
})
export type SuggestionInsert = z.infer<typeof suggestionInsertSchema>
