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
  QuestionOrigin,
  QuestionStatus,
  QuestionTopic,
  ThoughtKind,
  TrackerInputType,
  TranscriptKind,
  LinkType,
  NoticedQuote,
  NoticedStatus,
  ThemeStatus,
} from '@bullet/core'
import {
  blob,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

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
    /** No usable server transcript: the text is the phone's live draft (see core bullet.ts). */
    text_from_draft: integer('text_from_draft', { mode: 'boolean' }).notNull().default(false),
    /** This capture answers a clarifying question. */
    answers_question_id: text('answers_question_id'),
    /** This capture closes an open-loop thought "with a note". */
    resolves_thought_id: text('resolves_thought_id'),
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
    /** Open loops (`to_check` / `question`): when the user closed it, and the note that did. */
    resolved_at: integer('resolved_at'),
    resolved_by_bullet_id: text('resolved_by_bullet_id'),
    /** Reads as self-harm, crisis or acute distress: keeps reflective questions away. */
    sensitive: integer('sensitive', { mode: 'boolean' }).notNull().default(false),
    /** "Not this one" on a reflective question about it: it is never asked about again. */
    never_ask: integer('never_ask', { mode: 'boolean' }).notNull().default(false),
    /** Named people, places, projects (segmentation), for linking. Server-only. */
    entities: text('entities', { mode: 'json' }).$type<string[]>().notNull().default([]),
  },
  (t) => [index('thoughts_bullet_idx').on(t.source_bullet_id)],
)

/**
 * Questions: clarifying ones about a capture (max 3 per capture), and reflective ones (from a
 * capture, a stale open loop, or the evergreen list; the last have no source capture).
 */
export const questions = sqliteTable(
  'questions',
  {
    ...ownedFields(),
    source_bullet_id: text('source_bullet_id').references(() => bullets.id),
    source_thought_id: text('source_thought_id'),
    suggestion_id: text('suggestion_id'),
    kind: text('kind').$type<QuestionKind>().notNull().default('clarifying'),
    origin: text('origin').$type<QuestionOrigin>().notNull().default('capture'),
    topic: text('topic').$type<QuestionTopic>().notNull(),
    text: text('text').notNull(),
    options: text('options', { mode: 'json' }).$type<string[]>().notNull(),
    status: text('status').$type<QuestionStatus>().notNull(),
    answer_bullet_id: text('answer_bullet_id'),
    /** The option the user tapped (`question.answer`). */
    answer_option: text('answer_option'),
    resolved_at: integer('resolved_at'),
    /** Reflective "Later": hidden until then; allowed once. */
    snoozed_until: integer('snoozed_until'),
    snooze_count: integer('snooze_count').notNull().default(0),
    /** Evergreen questions: which template. */
    template_id: text('template_id'),
    /** Connection questions: the earlier thought it asks about. */
    related_thought_id: text('related_thought_id'),
  },
  (t) => [
    index('questions_bullet_idx').on(t.source_bullet_id),
    index('questions_kind_idx').on(t.owner_id, t.kind, t.status),
  ],
)

/**
 * Reflective-question jobs: one per capture, run by the same worker AFTER every extraction job
 * that is ready (lower priority), so a capture's things never wait on it. `text_version` pins the
 * capture text it read; a newer text discards the result.
 */
export const reflectJobs = sqliteTable(
  'reflect_jobs',
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
    last_error: text('last_error'),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
  },
  (t) => [index('reflect_jobs_ready_idx').on(t.status, t.run_after)],
)

/**
 * Link jobs (slice 3): one per capture, run right after its extraction (before its reflect job):
 * embed the thoughts, link them, check open loops. `pending_question` holds a connection-question
 * candidate while the capture's reflect job may still ask its own question.
 */
export const linkJobs = sqliteTable(
  'link_jobs',
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
    last_error: text('last_error'),
    pending_question: text('pending_question', { mode: 'json' }).$type<{
      thought_id: string
      related_thought_id: string
      score: number
    }>(),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
  },
  (t) => [index('link_jobs_ready_idx').on(t.status, t.run_after)],
)

/**
 * One vector per thought, with the embedder key (model + template) and a hash of the text it was
 * made from: another key or another text means embedding it again.
 */
export const thoughtEmbeddings = sqliteTable(
  'thought_embeddings',
  {
    thought_id: text('thought_id')
      .primaryKey()
      .references(() => thoughts.id),
    owner_id: text('owner_id')
      .notNull()
      .references(() => users.id),
    model: text('model').notNull(),
    text_hash: text('text_hash').notNull(),
    dim: integer('dim').notNull(),
    vector: blob('vector', { mode: 'buffer' }).notNull(),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
  },
  (t) => [index('thought_embeddings_owner_idx').on(t.owner_id, t.model)],
)

/** The mean of the background sentences per embedder key (centres an LLM's embeddings). */
export const embeddingBaselines = sqliteTable('embedding_baselines', {
  model: text('model').primaryKey(),
  dim: integer('dim').notNull(),
  /** Sum of the unit vectors (Float32 bytes) and how many. */
  sum: blob('sum', { mode: 'buffer' }).notNull(),
  count: integer('count').notNull(),
  created_at: integer('created_at').notNull(),
})

/**
 * Links between thoughts of different captures. Undirected, stored once with `a` the earlier
 * thought. `origin`: made per capture, by a "Same thing" answer, or kept by a nightly review.
 * `reviewed_at`: the nightly model typed/confirmed it.
 */
export const thoughtLinks = sqliteTable(
  'thought_links',
  {
    ...ownedFields(),
    a_thought_id: text('a_thought_id')
      .notNull()
      .references(() => thoughts.id),
    a_bullet_id: text('a_bullet_id').notNull(),
    b_thought_id: text('b_thought_id')
      .notNull()
      .references(() => thoughts.id),
    b_bullet_id: text('b_bullet_id').notNull(),
    type: text('type').$type<LinkType>().notNull(),
    score: real('score').notNull(),
    origin: text('origin').$type<'capture' | 'user'>().notNull(),
    reviewed_at: integer('reviewed_at'),
  },
  (t) => [
    uniqueIndex('thought_links_pair_idx').on(t.owner_id, t.a_thought_id, t.b_thought_id),
    index('thought_links_b_idx').on(t.b_thought_id),
  ],
)

/**
 * Pairs that must never be linked (`link`) or proposed as an answer (`resolve`) again. Stored
 * with the smaller id first, so one row covers both directions. `source`: the user's correction,
 * or a nightly review that found them unrelated.
 */
export const linkVetoes = sqliteTable(
  'link_vetoes',
  {
    owner_id: text('owner_id')
      .notNull()
      .references(() => users.id),
    lo_thought_id: text('lo_thought_id').notNull(),
    hi_thought_id: text('hi_thought_id').notNull(),
    scope: text('scope').$type<'link' | 'resolve'>().notNull(),
    source: text('source').$type<'user' | 'model'>().notNull(),
    created_at: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.owner_id, t.lo_thought_id, t.hi_thought_id, t.scope] })],
)

/**
 * Themes. `model_name` is the nightly model's name (kept, never shown once the user renamed it:
 * `user_name`). `vetoed_thought_ids`: "Not a theme" — the thoughts it held then. `sensitive_share`
 * is server-only.
 */
export const themes = sqliteTable(
  'themes',
  {
    ...ownedFields(),
    model_name: text('model_name'),
    user_name: text('user_name'),
    status: text('status').$type<ThemeStatus>().notNull(),
    retired_by: text('retired_by').$type<'user' | 'merge'>(),
    merged_into_theme_id: text('merged_into_theme_id'),
    vetoed_thought_ids: text('vetoed_thought_ids', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default([]),
    thought_count: integer('thought_count').notNull().default(0),
    day_count: integer('day_count').notNull().default(0),
    first_seen_at: integer('first_seen_at'),
    last_seen_at: integer('last_seen_at'),
    sensitive_share: real('sensitive_share').notNull().default(0),
  },
  (t) => [index('themes_owner_idx').on(t.owner_id, t.status)],
)

/** The thoughts of a theme (deleted rows: thoughts it held before a merge or an edit). */
export const themeThoughts = sqliteTable(
  'theme_thoughts',
  {
    ...ownedFields(),
    theme_id: text('theme_id')
      .notNull()
      .references(() => themes.id),
    thought_id: text('thought_id')
      .notNull()
      .references(() => thoughts.id),
    bullet_id: text('bullet_id').notNull(),
  },
  (t) => [
    uniqueIndex('theme_thoughts_pair_idx').on(t.theme_id, t.thought_id),
    index('theme_thoughts_thought_idx').on(t.thought_id),
  ],
)

/** A merged theme points at the theme it was merged into; later matches fold into that one. */
export const themeAliases = sqliteTable('theme_aliases', {
  alias_theme_id: text('alias_theme_id')
    .primaryKey()
    .references(() => themes.id),
  owner_id: text('owner_id')
    .notNull()
    .references(() => users.id),
  survivor_theme_id: text('survivor_theme_id')
    .notNull()
    .references(() => themes.id),
  created_at: integer('created_at').notNull(),
})

/** Noticed cards: "«quote» · came up N times in M days". */
export const noticedCards = sqliteTable(
  'noticed_cards',
  {
    ...ownedFields(),
    theme_id: text('theme_id')
      .notNull()
      .references(() => themes.id),
    headline: text('headline').notNull(),
    /** The thought the headline quotes (always one of `quotes`). Server-only. */
    headline_thought_id: text('headline_thought_id'),
    quotes: text('quotes', { mode: 'json' }).$type<NoticedQuote[]>().notNull(),
    count: integer('count').notNull(),
    days: integer('days').notNull(),
    status: text('status').$type<NoticedStatus>().notNull(),
    opened_at: integer('opened_at'),
    resolved_at: integer('resolved_at'),
  },
  (t) => [index('noticed_cards_owner_idx').on(t.owner_id, t.created_at)],
)

/** Nightly runs (themes, link review, Noticed): one row per run, for scheduling and catch-up. */
export const nightlyRuns = sqliteTable('nightly_runs', {
  id: text('id').primaryKey(),
  /** The 02:00 slot this run covers. */
  slot_at: integer('slot_at').notNull(),
  started_at: integer('started_at').notNull(),
  finished_at: integer('finished_at'),
  status: text('status').$type<'running' | 'done' | 'failed' | 'yielded'>().notNull(),
  stats: text('stats', { mode: 'json' }).$type<Record<string, unknown>>(),
  error: text('error'),
})

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
    /** Last manual edit/delete; nothing automatic overwrites the row after it. */
    user_edited_at: integer('user_edited_at'),
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
    user_edited_at: integer('user_edited_at'),
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
  user_edited_at: integer('user_edited_at'),
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
  reflectJobs,
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
  linkJobs,
  thoughtEmbeddings,
  embeddingBaselines,
  thoughtLinks,
  linkVetoes,
  themes,
  themeThoughts,
  themeAliases,
  noticedCards,
  nightlyRuns,
  syncOps,
  syncChanges,
  syncCounter,
}
