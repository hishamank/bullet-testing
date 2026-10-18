import { z } from 'zod'
import { activityInsertSchema } from './entities/activity'
import { eventInsertSchema } from './entities/event'
import { taskInsertSchema } from './entities/task'
import { trackerInsertSchema } from './entities/tracker'
import { trackerEntryValueSchema, trackerEntryInsertSchema } from './entities/trackerEntry'
import {
  type SuggestionOperation,
  type TargetKind,
  taskPrioritySchema,
  taskStatusSchema,
} from './enums'
import { nonEmptyString, timestampMs, uuid } from './primitives'
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
  event: eventInsertSchema,
  tracker: trackerInsertSchema,
  tracker_entry: trackerEntryInsertSchema,
  activity: activityInsertSchema,
} as const satisfies Record<TargetKind, z.ZodTypeAny>

export type TargetKindInsertSchemas = typeof targetKindInsertSchemas

/**
 * Field-level PATCH schemas for `operation: 'update'` suggestions: only the user-mutable fields,
 * all optional, unknown keys rejected, and at least one field present. An update payload carries
 * ONLY what changes (e.g. mark-done is `{ status: 'done' }`), so applying it can never write back
 * a stale snapshot of fields the user edited in the meantime.
 */
const patch = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object(shape)
    .partial()
    .strict()
    .refine((p) => Object.keys(p).length > 0, {
      message: 'an update must change at least one field',
    })

export const targetKindUpdateSchemas = {
  task: patch({
    status: taskStatusSchema,
    title: nonEmptyString(),
    notes: z.string().nullable(),
    due_at: timestampMs().nullable(),
    priority: taskPrioritySchema.nullable(),
  }),
  event: patch({
    title: nonEmptyString(),
    starts_at: timestampMs(),
    ends_at: timestampMs().nullable(),
    all_day: z.boolean(),
    location: z.string().nullable(),
    notes: z.string().nullable(),
  }),
  tracker: patch({ name: nonEmptyString() }),
  tracker_entry: patch({ value: trackerEntryValueSchema, logged_at: timestampMs() }),
  activity: patch({
    name: nonEmptyString(),
    occurred_at: timestampMs(),
    tracker_id: uuid().nullable(),
    notes: z.string().nullable(),
    quantity: z.number().nullable(),
    unit: z.string().nullable(),
  }),
} as const satisfies Record<TargetKind, z.ZodTypeAny>

export type TargetKindUpdateSchemas = typeof targetKindUpdateSchemas

/** The INSERT schema for a given target kind. */
// TODO(review): thin wrapper over `targetKindInsertSchemas[kind]` — kept deliberately for
// call-site ergonomics (named, documented accessor). See REVIEW-BACKLOG.md.
export const insertSchemaFor = <K extends TargetKind>(kind: K): TargetKindInsertSchemas[K] =>
  targetKindInsertSchemas[kind]

/**
 * Validate a suggestion `payload` for its `target_kind` and `operation`: `create`/`append` against
 * the kind's INSERT schema, `update` against its field-level PATCH schema.
 *
 * Pure: returns the Zod `SafeParseReturnType` (never throws), so callers can inspect
 * `.success` / `.error` / `.data`. Used by the apply engine before persisting.
 */
export const validateSuggestionPayload = (
  target_kind: TargetKind,
  payload: SuggestionPayload,
  operation: SuggestionOperation = 'create',
): z.SafeParseReturnType<unknown, Record<string, unknown>> => {
  const schema: z.ZodTypeAny =
    operation === 'update'
      ? targetKindUpdateSchemas[target_kind]
      : targetKindInsertSchemas[target_kind]
  return schema.safeParse(payload)
}
