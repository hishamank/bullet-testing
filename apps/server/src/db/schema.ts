/**
 * The home server's SQLite schema (Drizzle). Conventions (CLAUDE.md §3): `owner_id` on every
 * owned row, epoch-ms integer timestamps, soft delete via `state`, client-minted UUID ids.
 *
 * Generate a migration after changing this file: `pnpm --filter server db:generate`.
 */

import type {
  AudioUploadStatus,
  BulletSource,
  ProcessingErrorCode,
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
  QuestionKind,
  QuestionStatus,
  QuestionTopic,
  ThoughtKind,
  TrackerInputType,
  TranscriptKind,
} from '@bullet/core'
import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

const ownedFields = () => ({
  id: text('id').primaryKey(),
  owner_id: text('owner_id')
    .notNull()
    .references(() => users.id),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
  state: text('state').$type<RecordState>().notNull().default('active'),
})

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name'),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
})

/** One row per phone/client. Only a SHA-256 hash of the bearer token is stored. */
export const devices = sqliteTable('devices', {
  id: text('id').primaryKey(),
  owner_id: text('owner_id')
    .notNull()
    .references(() => users.id),
  name: text('name').notNull(),
  token_hash: text('token_hash').notNull().unique(),
  created_at: integer('created_at').notNull(),
  last_seen_at: integer('last_seen_at'),
  revoked_at: integer('revoked_at'),
})

export const bullets = sqliteTable(
  'bullets',
  {
    ...ownedFields(),
    text: text('text').notNull(),
    captured_at: integer('captured_at').notNull(),
    timezone: text('timezone').notNull(),
    source: text('source').$type<BulletSource>().notNull(),
    /** The user typed/edited this text: server transcripts never overwrite it. */
    text_edited_by_user: integer('text_edited_by_user', { mode: 'boolean' })
      .notNull()
      .default(false),
    /** This capture answers a clarifying question. */
    answers_question_id: text('answers_question_id'),
    /** Client clock of the latest accepted text (capture or edit); older edits are `stale`. */
    text_updated_at: integer('text_updated_at').notNull(),
    /** Bumped on every text change, so a job started on an older text discards its result. */
    text_version: integer('text_version').notNull().default(1),
    proc_status: text('proc_status').$type<ServerBulletProcessingStatus>().notNull(),
    proc_attempts: integer('proc_attempts').notNull().default(0),
    proc_error_code: text('proc_error_code').$type<ProcessingErrorCode>(),
    proc_error_message: text('proc_error_message'),
    proc_next_retry_at: integer('proc_next_retry_at'),
    proc_updated_at: integer('proc_updated_at').notNull(),
  },
  (t) => [index('bullets_owner_idx').on(t.owner_id, t.captured_at)],
)

/** `waiting_audio`: a voice bullet whose recording has not fully arrived; queued on completion. */
export type JobStatus = 'waiting_audio' | 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

/**
 * The durable processing queue: at most one job per bullet (re-enqueueing resets it). `attempts`
 * counts tries of THIS run; `text_version` pins the bullet text the job is working on.
 */
export const jobs = sqliteTable(
  'jobs',
  {
    bullet_id: text('bullet_id')
      .primaryKey()
      .references(() => bullets.id),
    owner_id: text('owner_id')
      .notNull()
      .references(() => users.id),
    status: text('status').$type<JobStatus>().notNull(),
    attempts: integer('attempts').notNull().default(0),
    text_version: integer('text_version').notNull(),
    run_after: integer('run_after').notNull(),
    locked_at: integer('locked_at'),
    last_error_code: text('last_error_code').$type<ProcessingErrorCode>(),
    last_error_message: text('last_error_message'),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
  },
  (t) => [index('jobs_ready_idx').on(t.status, t.run_after)],
)

export const suggestions = sqliteTable(
  'suggestions',
  {
    ...ownedFields(),
    source_bullet_id: text('source_bullet_id')
      .notNull()
      .references(() => bullets.id),
    source_thought_id: text('source_thought_id'),
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
    auto_applied: integer('auto_applied', { mode: 'boolean' }).notNull().default(false),
    /** For applied UPDATEs: the patched fields' values before / after, for undo + conflict check. */
    applied_before: text('applied_before', { mode: 'json' }).$type<Record<string, unknown>>(),
    applied_after: text('applied_after', { mode: 'json' }).$type<Record<string, unknown>>(),
  },
  (t) => [index('suggestions_bullet_idx').on(t.source_bullet_id)],
)

const provenance = () => ({
  source_bullet_id: text('source_bullet_id').references(() => bullets.id),
  source_thought_id: text('source_thought_id'),
})

/** One separate thought within a capture. Every thought is kept. */
export const thoughts = sqliteTable(
  'thoughts',
  {
    ...ownedFields(),
    source_bullet_id: text('source_bullet_id')
      .notNull()
      .references(() => bullets.id),
    position: integer('position').notNull(),
    text: text('text').notNull(),
    span_start: integer('span_start'),
    span_end: integer('span_end'),
    kind: text('kind').$type<ThoughtKind>().notNull(),
    kind_source: text('kind_source').$type<'engine' | 'user'>().notNull(),
  },
  (t) => [index('thoughts_bullet_idx').on(t.source_bullet_id)],
)

/** Clarifying questions the engine asks about a capture (max 3 per capture). */
export const questions = sqliteTable(
  'questions',
  {
    ...ownedFields(),
    source_bullet_id: text('source_bullet_id')
      .notNull()
      .references(() => bullets.id),
    source_thought_id: text('source_thought_id'),
    suggestion_id: text('suggestion_id'),
    kind: text('kind').$type<QuestionKind>().notNull(),
    topic: text('topic').$type<QuestionTopic>().notNull(),
    text: text('text').notNull(),
    options: text('options', { mode: 'json' }).$type<string[]>().notNull(),
    status: text('status').$type<QuestionStatus>().notNull(),
    answer_bullet_id: text('answer_bullet_id'),
    resolved_at: integer('resolved_at'),
  },
  (t) => [index('questions_bullet_idx').on(t.source_bullet_id)],
)

export const tasks = sqliteTable(
  'tasks',
  {
    ...ownedFields(),
    ...provenance(),
    status: text('status').$type<TaskStatus>().notNull(),
    title: text('title').notNull(),
    notes: text('notes'),
    due_at: integer('due_at'),
    priority: text('priority').$type<TaskPriority>(),
  },
  (t) => [index('tasks_owner_idx').on(t.owner_id, t.status)],
)

export const events = sqliteTable(
  'events',
  {
    ...ownedFields(),
    ...provenance(),
    title: text('title').notNull(),
    starts_at: integer('starts_at').notNull(),
    ends_at: integer('ends_at'),
    all_day: integer('all_day', { mode: 'boolean' }).notNull(),
    location: text('location'),
    notes: text('notes'),
  },
  (t) => [index('events_owner_idx').on(t.owner_id, t.starts_at)],
)

export const trackers = sqliteTable('trackers', {
  ...ownedFields(),
  ...provenance(),
  name: text('name').notNull(),
  input_type: text('input_type').$type<TrackerInputType>().notNull(),
  config: text('config', { mode: 'json' }).$type<TrackerConfig>().notNull(),
})

export const trackerEntries = sqliteTable('tracker_entries', {
  ...ownedFields(),
  ...provenance(),
  tracker_id: text('tracker_id')
    .notNull()
    .references(() => trackers.id),
  value: text('value', { mode: 'json' }).$type<TrackerEntryValue>().notNull(),
  logged_at: integer('logged_at').notNull(),
})

export const activities = sqliteTable('activities', {
  ...ownedFields(),
  ...provenance(),
  name: text('name').notNull(),
  occurred_at: integer('occurred_at').notNull(),
  tracker_id: text('tracker_id').references(() => trackers.id),
  notes: text('notes'),
  quantity: real('quantity'),
  unit: text('unit'),
})

/** A voice note's recording. The bytes live in the audio store under `storage_key`. */
export const audioAttachments = sqliteTable(
  'audio_attachments',
  {
    ...ownedFields(),
    bullet_id: text('bullet_id')
      .notNull()
      .references(() => bullets.id),
    mime_type: text('mime_type').notNull(),
    duration_ms: integer('duration_ms').notNull(),
    size_bytes: integer('size_bytes').notNull(),
    sha256: text('sha256'),
    storage_key: text('storage_key').notNull(),
    received_bytes: integer('received_bytes').notNull().default(0),
    upload_status: text('upload_status').$type<AudioUploadStatus>().notNull(),
  },
  (t) => [index('audio_bullet_idx').on(t.bullet_id)],
)

/** Transcripts of a recording: the device draft and the server's (Whisper) transcript. */
export const transcripts = sqliteTable(
  'transcripts',
  {
    ...ownedFields(),
    bullet_id: text('bullet_id')
      .notNull()
      .references(() => bullets.id),
    attachment_id: text('attachment_id')
      .notNull()
      .references(() => audioAttachments.id),
    kind: text('kind').$type<TranscriptKind>().notNull(),
    text: text('text').notNull(),
    engine: text('engine').notNull(),
    model: text('model'),
    languages: text('languages', { mode: 'json' }).$type<string[]>().notNull(),
    transcribed_at: integer('transcribed_at').notNull(),
  },
  (t) => [index('transcripts_attachment_idx').on(t.attachment_id)],
)

/** Push idempotency: the outcome of every op_id already handled, per owner. */
export const syncOps = sqliteTable(
  'sync_ops',
  {
    owner_id: text('owner_id').notNull(),
    op_id: text('op_id').notNull(),
    type: text('type').notNull(),
    result: text('result', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    created_at: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.owner_id, t.op_id] })],
)

/**
 * Pull cursor index: one row per changed entity holding the sequence number of its LATEST change.
 * Re-touching an entity moves it forward, so the table stays as small as the data.
 */
export const syncChanges = sqliteTable(
  'sync_changes',
  {
    owner_id: text('owner_id').notNull(),
    kind: text('kind').notNull(),
    entity_id: text('entity_id').notNull(),
    seq: integer('seq').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.owner_id, t.kind, t.entity_id] }),
    index('sync_changes_seq_idx').on(t.owner_id, t.seq),
  ],
)

/** Single-row counter feeding `sync_changes.seq`. */
export const syncCounter = sqliteTable('sync_counter', {
  id: integer('id').primaryKey(),
  seq: integer('seq').notNull(),
})

export const schema = {
  users,
  devices,
  bullets,
  jobs,
  suggestions,
  tasks,
  events,
  trackers,
  trackerEntries,
  activities,
  audioAttachments,
  transcripts,
  thoughts,
  questions,
  syncOps,
  syncChanges,
  syncCounter,
}
