import type { z } from 'zod'
import { activityInsertSchema } from './entities/activity'
import { taskInsertSchema } from './entities/task'
import { trackerInsertSchema } from './entities/tracker'
import { trackerEntryInsertSchema } from './entities/trackerEntry'
import type { TargetKind } from './enums'
import type { SuggestionPayload } from './suggestion'

/**
 * Registry mapping each `TargetKind` to that kind's INSERT schema. This is the bridge
 * between a Suggestion's `target_kind` and the concrete shape its `payload` must satisfy
 * (CLAUDE.md §4.3: the payload is validated against that kind's Zod schema).
 *
 * `as const satisfies` keeps the literal-keyed mapping while statically guaranteeing every
 * `TargetKind` has an entry.
 */
export const targetKindInsertSchemas = {
  task: taskInsertSchema,
  tracker: trackerInsertSchema,
  tracker_entry: trackerEntryInsertSchema,
  activity: activityInsertSchema,
} as const satisfies Record<TargetKind, z.ZodTypeAny>

export type TargetKindInsertSchemas = typeof targetKindInsertSchemas

/** The INSERT schema for a given target kind. */
export const insertSchemaFor = <K extends TargetKind>(kind: K): TargetKindInsertSchemas[K] =>
  targetKindInsertSchemas[kind]

/**
 * Validate a suggestion `payload` against the INSERT schema for its `target_kind`.
 *
 * Pure: returns the Zod `SafeParseReturnType` (never throws), so callers can inspect
 * `.success` / `.error` / `.data`. Used by the apply/commit layer before persisting a
 * suggestion's proposed entity.
 */
export const validateSuggestionPayload = <K extends TargetKind>(
  target_kind: K,
  payload: SuggestionPayload,
): z.SafeParseReturnType<unknown, z.infer<TargetKindInsertSchemas[K]>> => {
  const schema = targetKindInsertSchemas[target_kind]
  return schema.safeParse(payload) as z.SafeParseReturnType<
    unknown,
    z.infer<TargetKindInsertSchemas[K]>
  >
}
