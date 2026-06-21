/**
 * @bullet/core — domain types + Zod schemas for the v1 base entity set.
 *
 * Pure package: Zod schemas, the TypeScript types inferred from them (the single source of
 * truth), the shared field conventions, and small pure helpers. No DB, no IO, no network,
 * no `node:*`, no other workspace packages. The only dependency is zod.
 *
 * Every entity exposes a SELECT schema (the full persisted row) and an INSERT schema
 * (creation input where the server-managed fields id/created_at/updated_at/state — and
 * defaultable fields like task.status / suggestion.status — are optional).
 */

export const PACKAGE_NAME = '@bullet/core'

export {
  ownedTimestampedStateFields,
  ownedTimestampedStateInsertFields,
  ownedTimestampedStateSchema,
  sourceBulletIdNullable,
  sourceBulletIdRequired,
} from './base'
// Entities — Activity
export {
  type Activity,
  type ActivityInsert,
  activityInsertSchema,
  activitySelectSchema,
} from './entities/activity'
// Entities — Bullet
export {
  type Bullet,
  type BulletInsert,
  bulletInsertSchema,
  bulletSelectSchema,
} from './entities/bullet'
// Entities — Task
export { type Task, type TaskInsert, taskInsertSchema, taskSelectSchema } from './entities/task'
// Entities — Tracker (+ config union)
export {
  booleanConfigSchema,
  multiSelectConfigSchema,
  numberConfigSchema,
  scaleConfigSchema,
  singleSelectConfigSchema,
  type Tracker,
  type TrackerConfig,
  type TrackerInsert,
  textConfigSchema,
  trackerConfigSchema,
  trackerInsertSchema,
  trackerSelectSchema,
} from './entities/tracker'
// Entities — TrackerEntry
export {
  type TrackerEntry,
  type TrackerEntryInsert,
  type TrackerEntryValue,
  trackerEntryInsertSchema,
  trackerEntrySelectSchema,
  trackerEntryValueSchema,
} from './entities/trackerEntry'
// Entities — User
export { type User, type UserInsert, userInsertSchema, userSelectSchema } from './entities/user'
// Enums / closed unions (schemas + inferred types)
export {
  type RecordState,
  recordStateSchema,
  type SuggestionOperation,
  type SuggestionStatus,
  type SuggestionTier,
  suggestionOperationSchema,
  suggestionStatusSchema,
  suggestionTierSchema,
  type TargetKind,
  type TaskPriority,
  type TaskStatus,
  type TrackerInputType,
  targetKindSchema,
  taskPrioritySchema,
  taskStatusSchema,
  trackerInputTypeSchema,
} from './enums'
// Primitives & shared field conventions
export { nonEmptyString, timestampMs, uuid } from './primitives'
// Registry + payload validation
export {
  insertSchemaFor,
  type TargetKindInsertSchemas,
  targetKindInsertSchemas,
  validateSuggestionPayload,
} from './registry'
// Suggestion (extraction envelope)
export {
  confidenceSchema,
  DEFINITION_TARGET_KINDS,
  type DefinitionTargetKind,
  type Suggestion,
  type SuggestionInsert,
  type SuggestionPayload,
  suggestionInsertSchema,
  suggestionPayloadSchema,
  suggestionSelectSchema,
} from './suggestion'
