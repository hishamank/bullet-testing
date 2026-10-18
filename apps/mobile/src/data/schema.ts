/**
 * The phone's local SQLite schema (Drizzle, expo-sqlite on device, better-sqlite3 in tests).
 *
 *  - `bullets`  — every capture, written locally FIRST. `server_*` columns mirror the processing
 *                 status the server last reported (null = the server has never confirmed it).
 *  - `outbox`   — every local change not yet acknowledged by the server, in order. Written in the
 *                 same transaction as the change itself.
 *  - mirrors    — suggestions and the entities they produced, as last pulled.
 *  - `sync_state` — the pull cursor and bookkeeping.
 *
 * Single-user device, so no `owner_id`. Timestamps are epoch ms. After changing this file run
 * `pnpm --filter mobile db:generate`.
 */

import type {
  AudioUploadStatus,
  BulletSource,
  ProcessingErrorCode,
  PushOp,
  RecordState,
  ServerBulletProcessingStatus,
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
  TranscriptKind,
} from '@bullet/core'
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

const rowFields = () => ({
  id: text('id').primaryKey(),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
  state: text('state').$type<RecordState>().notNull().default('active'),
})

export const bullets = sqliteTable(
  'bullets',
  {
    ...rowFields(),
    text: text('text').notNull(),
    captured_at: integer('captured_at').notNull(),
    timezone: text('timezone').notNull(),
    source: text('source').$type<BulletSource>().notNull(),
    text_edited_by_user: integer('text_edited_by_user', { mode: 'boolean' })
      .notNull()
      .default(false),
    server_status: text('server_status').$type<ServerBulletProcessingStatus>(),
    server_attempts: integer('server_attempts').notNull().default(0),
    server_error_code: text('server_error_code').$type<ProcessingErrorCode>(),
    server_error_message: text('server_error_message'),
    server_next_retry_at: integer('server_next_retry_at'),
    /** Set when the server refused one of this bullet's operations for good. */
    sync_rejection: text('sync_rejection'),
  },
  (t) => [index('bullets_captured_idx').on(t.captured_at)],
)

export const outbox = sqliteTable(
  'outbox',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    op_id: text('op_id').notNull().unique(),
    type: text('type').$type<PushOp['type']>().notNull(),
    /** The bullet / suggestion the op is about, for the saved_local overlay and pull merging. */
    bullet_id: text('bullet_id'),
    suggestion_id: text('suggestion_id'),
    op: text('op', { mode: 'json' }).$type<PushOp>().notNull(),
    created_at: integer('created_at').notNull(),
    attempts: integer('attempts').notNull().default(0),
    last_error: text('last_error'),
  },
  (t) => [
    index('outbox_bullet_idx').on(t.bullet_id),
    index('outbox_suggestion_idx').on(t.suggestion_id),
  ],
)

export const suggestions = sqliteTable(
  'suggestions',
  {
    ...rowFields(),
    source_bullet_id: text('source_bullet_id').notNull(),
    target_kind: text('target_kind').$type<TargetKind>().notNull(),
    operation: text('operation').$type<SuggestionOperation>().notNull(),
    target_id: text('target_id'),
    payload: text('payload', { mode: 'json' }).$type<SuggestionPayload>().notNull(),
    confidence: real('confidence').notNull(),
    tier: text('tier').$type<SuggestionTier>().notNull(),
    status: text('status').$type<SuggestionStatus>().notNull(),
    resolved_at: integer('resolved_at'),
    applied_entity_id: text('applied_entity_id'),
    applied_at: integer('applied_at'),
    auto_applied: integer('auto_applied', { mode: 'boolean' }).notNull(),
  },
  (t) => [index('suggestions_bullet_idx').on(t.source_bullet_id)],
)

const provenance = () => ({ source_bullet_id: text('source_bullet_id') })

export const tasks = sqliteTable('tasks', {
  ...rowFields(),
  ...provenance(),
  status: text('status').$type<TaskStatus>().notNull(),
  title: text('title').notNull(),
  notes: text('notes'),
  due_at: integer('due_at'),
  priority: text('priority').$type<TaskPriority>(),
})

export const events = sqliteTable('events', {
  ...rowFields(),
  ...provenance(),
  title: text('title').notNull(),
  starts_at: integer('starts_at').notNull(),
  ends_at: integer('ends_at'),
  all_day: integer('all_day', { mode: 'boolean' }).notNull(),
  location: text('location'),
  notes: text('notes'),
})

export const trackers = sqliteTable('trackers', {
  ...rowFields(),
  ...provenance(),
  name: text('name').notNull(),
  input_type: text('input_type').$type<TrackerInputType>().notNull(),
  config: text('config', { mode: 'json' }).$type<TrackerConfig>().notNull(),
})

export const trackerEntries = sqliteTable('tracker_entries', {
  ...rowFields(),
  ...provenance(),
  tracker_id: text('tracker_id').notNull(),
  value: text('value', { mode: 'json' }).$type<TrackerEntryValue>().notNull(),
  logged_at: integer('logged_at').notNull(),
})

export const activities = sqliteTable('activities', {
  ...rowFields(),
  ...provenance(),
  name: text('name').notNull(),
  occurred_at: integer('occurred_at').notNull(),
  tracker_id: text('tracker_id'),
  notes: text('notes'),
  quantity: real('quantity'),
  unit: text('unit'),
})

/**
 * A voice note's recording. `local_path` is the file on this phone (null for one recorded on
 * another device); it is kept permanently. `received_bytes` / `upload_status` track the upload.
 */
export const audioAttachments = sqliteTable(
  'audio_attachments',
  {
    ...rowFields(),
    bullet_id: text('bullet_id').notNull(),
    mime_type: text('mime_type').notNull(),
    duration_ms: integer('duration_ms').notNull(),
    size_bytes: integer('size_bytes').notNull(),
    sha256: text('sha256'),
    local_path: text('local_path'),
    received_bytes: integer('received_bytes').notNull().default(0),
    upload_status: text('upload_status').$type<AudioUploadStatus>().notNull(),
  },
  (t) => [index('audio_bullet_idx').on(t.bullet_id)],
)

export const transcripts = sqliteTable(
  'transcripts',
  {
    ...rowFields(),
    bullet_id: text('bullet_id').notNull(),
    attachment_id: text('attachment_id').notNull(),
    kind: text('kind').$type<TranscriptKind>().notNull(),
    text: text('text').notNull(),
    engine: text('engine').notNull(),
    model: text('model'),
    languages: text('languages', { mode: 'json' }).$type<string[]>().notNull(),
    transcribed_at: integer('transcribed_at').notNull(),
  },
  (t) => [index('transcripts_bullet_idx').on(t.bullet_id)],
)

export const syncState = sqliteTable('sync_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})

export const schema = {
  bullets,
  outbox,
  suggestions,
  tasks,
  events,
  trackers,
  trackerEntries,
  activities,
  audioAttachments,
  transcripts,
  syncState,
}
