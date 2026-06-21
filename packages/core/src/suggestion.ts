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

/**
 * Target kinds that are **definitions** (persistent, created once) rather than records.
 * Definitions are NEVER tier `auto` — minting one always requires user confirmation,
 * regardless of confidence (CLAUDE.md §4.5: eagerness scales inversely with permanence).
 *
 * v1 ships exactly one definition kind (`tracker`); designed to extend
 * (future: `'habit'`, `'goal'`).
 */
export const DEFINITION_TARGET_KINDS = ['tracker'] as const
export type DefinitionTargetKind = (typeof DEFINITION_TARGET_KINDS)[number]

const isDefinitionTargetKind = (kind: string): boolean =>
  (DEFINITION_TARGET_KINDS as readonly string[]).includes(kind)

/**
 * The cross-field coherence checks shared by the SELECT and INSERT suggestion schemas
 * (factored out so the invariants are written once and applied to both). Applied via
 * `.superRefine` AFTER the object is built, so `.default()`s and INSERT optionality are
 * untouched.
 *
 *  - `operation`↔`target_id` (CLAUDE.md §4.3): `create` has no existing target (target_id
 *    MUST be null); `append`/`update` mutate an existing entity (target_id MUST be non-null).
 *  - definitions are never `auto` (CLAUDE.md §4.5): a definition target kind cannot carry
 *    tier `auto` — it requires confirmation (`suggest`/`ask`).
 */
const refineSuggestionInvariants = (
  s: {
    operation: z.infer<typeof suggestionOperationSchema>
    target_id: string | null
    target_kind: z.infer<typeof targetKindSchema>
    tier: z.infer<typeof suggestionTierSchema>
  },
  ctx: z.RefinementCtx,
) => {
  // §4.3 — operation ↔ target_id coherence.
  if (s.operation === 'create' && s.target_id !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "operation 'create' must have target_id null (a new entity has no existing target)",
      path: ['target_id'],
    })
  }
  if ((s.operation === 'append' || s.operation === 'update') && s.target_id === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `operation '${s.operation}' requires a non-null target_id (the existing entity being changed)`,
      path: ['target_id'],
    })
  }

  // §4.5 — definitions are never `auto`.
  if (isDefinitionTargetKind(s.target_kind) && s.tier === 'auto') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `target_kind '${s.target_kind}' is a definition and requires confirmation: tier must be 'suggest' or 'ask', never 'auto'`,
      path: ['tier'],
    })
  }
}

export const suggestionSelectSchema = z
  .object({
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
  .superRefine(refineSuggestionInvariants)
export type Suggestion = z.infer<typeof suggestionSelectSchema>

export const suggestionInsertSchema = z
  .object({
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
  .superRefine(refineSuggestionInvariants)
export type SuggestionInsert = z.infer<typeof suggestionInsertSchema>
