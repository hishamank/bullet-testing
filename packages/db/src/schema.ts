/**
 * Drizzle schema for @bullet/db — SQLite via better-sqlite3.
 *
 * Written to stay **Postgres-portable** (a hosted multi-user future):
 *  - UUIDs / ids / FKs are `text` columns (never integer, never AUTOINCREMENT).
 *  - Timestamps are `integer` columns holding epoch **milliseconds** as a plain number
 *    (matching @bullet/core's `number` type). We store the ms number directly — NOT
 *    `{ mode: 'timestamp' }` (which is seconds/Date) and never SQLite date functions.
 *  - Enums are `text` columns with `{ enum: [...] }` matching the @bullet/core unions exactly.
 *  - JSON columns are `text({ mode: 'json' }).$type<...>()` with the matching core type
 *    (Postgres would use `jsonb`).
 *
 * The column shapes mirror the @bullet/core SELECT schemas (the persisted row). Types are
 * imported from @bullet/core — never re-declared here.
 */

import type {
  RecordState,
  SuggestionOperation,
  SuggestionPayload,
  SuggestionStatus,
  SuggestionTier,
  TargetKind,
  TaskPriority,
  TaskStatus,
  TrackerConfig,
  TrackerEntryValue,
  TrackerInputType,
} from '@bullet/core'
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { JobPayload, JobStatus, JobType } from './jobs'

/** The closed enum value sets, mirrored from @bullet/core (kept literal for drizzle). */
const RECORD_STATE = ['active', 'deleted'] as const satisfies readonly RecordState[]
const TASK_STATUS = [
  'todo',
  'in_progress',
  'done',
  'migrated',
  'cancelled',
] as const satisfies readonly TaskStatus[]
const TASK_PRIORITY = ['P1', 'P2', 'P3', 'P4'] as const satisfies readonly TaskPriority[]
const TRACKER_INPUT_TYPE = [
  'scale',
  'number',
  'single_select',
  'multi_select',
  'boolean',
  'text',
] as const satisfies readonly TrackerInputType[]
const SUGGESTION_STATUS = [
  'pending',
  'accepted',
  'edited',
  'rejected',
] as const satisfies readonly SuggestionStatus[]
const SUGGESTION_TIER = ['auto', 'suggest', 'ask'] as const satisfies readonly SuggestionTier[]
const SUGGESTION_OPERATION = [
  'create',
  'append',
  'update',
] as const satisfies readonly SuggestionOperation[]
const TARGET_KIND = [
  'task',
  'tracker',
  'tracker_entry',
  'activity',
] as const satisfies readonly TargetKind[]
const JOB_STATUS = ['queued', 'running', 'done', 'failed'] as const satisfies readonly JobStatus[]

/**
 * users — the owner root. It IS the owner, so it has no `owner_id`; it is not extracted, so
 * no `source_bullet_id`.
 */
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name'),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
})

/**
 * bullets — the atomic input unit and provenance anchor. Has no `source_bullet_id` of its own.
 */
export const bullets = sqliteTable('bullets', {
  id: text('id').primaryKey(),
  owner_id: text('owner_id')
    .notNull()
    .references(() => users.id),
  text: text('text').notNull(),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
  state: text('state', { enum: RECORD_STATE }).notNull(),
})

/** tasks — an actionable. */
export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    owner_id: text('owner_id')
      .notNull()
      .references(() => users.id),
    source_bullet_id: text('source_bullet_id').references(() => bullets.id),
    status: text('status', { enum: TASK_STATUS }).notNull(),
    title: text('title').notNull(),
    notes: text('notes'),
    due_at: integer('due_at'),
    priority: text('priority', { enum: TASK_PRIORITY }),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
    state: text('state', { enum: RECORD_STATE }).notNull(),
  },
  // Indexes the cascade-by-provenance lookup (softDelete 'cascade' filters on source_bullet_id).
  (t) => [index('tasks_source_bullet_id_idx').on(t.source_bullet_id)],
)

/** trackers — a definition of something measured. */
export const trackers = sqliteTable(
  'trackers',
  {
    id: text('id').primaryKey(),
    owner_id: text('owner_id')
      .notNull()
      .references(() => users.id),
    source_bullet_id: text('source_bullet_id').references(() => bullets.id),
    name: text('name').notNull(),
    input_type: text('input_type', { enum: TRACKER_INPUT_TYPE }).notNull(),
    config: text('config', { mode: 'json' }).$type<TrackerConfig>().notNull(),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
    state: text('state', { enum: RECORD_STATE }).notNull(),
  },
  (t) => [index('trackers_source_bullet_id_idx').on(t.source_bullet_id)],
)

/** tracker_entries — a value logged against a Tracker at a point in time. */
export const trackerEntries = sqliteTable(
  'tracker_entries',
  {
    id: text('id').primaryKey(),
    owner_id: text('owner_id')
      .notNull()
      .references(() => users.id),
    source_bullet_id: text('source_bullet_id').references(() => bullets.id),
    tracker_id: text('tracker_id')
      .notNull()
      .references(() => trackers.id),
    value: text('value', { mode: 'json' }).$type<TrackerEntryValue>().notNull(),
    logged_at: integer('logged_at').notNull(),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
    state: text('state', { enum: RECORD_STATE }).notNull(),
  },
  (t) => [index('tracker_entries_source_bullet_id_idx').on(t.source_bullet_id)],
)

/** activities — a record of something the user DID; may optionally link to a Tracker. */
export const activities = sqliteTable(
  'activities',
  {
    id: text('id').primaryKey(),
    owner_id: text('owner_id')
      .notNull()
      .references(() => users.id),
    source_bullet_id: text('source_bullet_id').references(() => bullets.id),
    name: text('name').notNull(),
    occurred_at: integer('occurred_at').notNull(),
    tracker_id: text('tracker_id').references(() => trackers.id),
    notes: text('notes'),
    quantity: real('quantity'),
    unit: text('unit'),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
    state: text('state', { enum: RECORD_STATE }).notNull(),
  },
  (t) => [index('activities_source_bullet_id_idx').on(t.source_bullet_id)],
)

/**
 * suggestions — the extraction envelope. `source_bullet_id` is NON-null (always derived from
 * a bullet). `target_id` is polymorphic across target kinds, so it carries NO FK.
 */
export const suggestions = sqliteTable(
  'suggestions',
  {
    id: text('id').primaryKey(),
    owner_id: text('owner_id')
      .notNull()
      .references(() => users.id),
    source_bullet_id: text('source_bullet_id')
      .notNull()
      .references(() => bullets.id),
    target_kind: text('target_kind', { enum: TARGET_KIND }).notNull(),
    operation: text('operation', { enum: SUGGESTION_OPERATION }).notNull(),
    // Polymorphic across kinds — intentionally NO foreign key.
    target_id: text('target_id'),
    payload: text('payload', { mode: 'json' }).$type<SuggestionPayload>().notNull(),
    confidence: real('confidence').notNull(),
    tier: text('tier', { enum: SUGGESTION_TIER }).notNull(),
    status: text('status', { enum: SUGGESTION_STATUS }).notNull(),
    resolved_at: integer('resolved_at'),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
    state: text('state', { enum: RECORD_STATE }).notNull(),
  },
  (t) => [index('suggestions_source_bullet_id_idx').on(t.source_bullet_id)],
)

/**
 * jobs — the serial queue for the future worker (e.g. `extract_bullet`). No soft-delete
 * `state`; `status` is its lifecycle.
 */
export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  // Nullable — queue-scoping insurance for a multi-user future.
  owner_id: text('owner_id'),
  type: text('type').$type<JobType>().notNull(),
  payload: text('payload', { mode: 'json' }).$type<JobPayload>().notNull(),
  status: text('status', { enum: JOB_STATUS }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  error: text('error'),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
  started_at: integer('started_at'),
  finished_at: integer('finished_at'),
})

/** A convenience map of every table — handy for the drizzle client `{ schema }` option. */
export const schema = {
  users,
  bullets,
  tasks,
  trackers,
  trackerEntries,
  activities,
  suggestions,
  jobs,
}
