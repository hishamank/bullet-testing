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
  QuestionKind,
  QuestionOrigin,
  QuestionStatus,
  QuestionTopic,
  ThoughtKind,
  TrackerInputType,
  TranscriptKind,
  LinkType,
  LinkVisibility,
  NoticedQuote,
  NoticedStatus,
  ThemeStatus,
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
    /** The server found no usable speech: the text is this phone's live draft. */
    text_from_draft: integer('text_from_draft', { mode: 'boolean' }).notNull().default(false),
    answers_question_id: text('answers_question_id'),
    resolves_thought_id: text('resolves_thought_id'),
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
    /** The row the op is about, for the saved_local overlay and pull merging. */
    bullet_id: text('bullet_id'),
    suggestion_id: text('suggestion_id'),
    thought_id: text('thought_id'),
    question_id: text('question_id'),
    /** A task / event / tracker entry the op edits by hand. */
    entity_id: text('entity_id'),
    op: text('op', { mode: 'json' }).$type<PushOp>().notNull(),
    created_at: integer('created_at').notNull(),
    attempts: integer('attempts').notNull().default(0),
    last_error: text('last_error'),
    /**
     * Not sent before this time (epoch ms; null = send now). The Inbox holds a decision for its
     * Undo window, so Undo can take it back before the server sees it. Expires on its own.
     */
    hold_until: integer('hold_until'),
  },
  (t) => [
    index('outbox_bullet_idx').on(t.bullet_id),
    index('outbox_suggestion_idx').on(t.suggestion_id),
    index('outbox_entity_idx').on(t.entity_id),
  ],
)

export const suggestions = sqliteTable(
  'suggestions',
  {
    ...rowFields(),
    source_bullet_id: text('source_bullet_id').notNull(),
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
    auto_applied: integer('auto_applied', { mode: 'boolean' }).notNull(),
  },
  (t) => [index('suggestions_bullet_idx').on(t.source_bullet_id)],
)

const provenance = () => ({
  source_bullet_id: text('source_bullet_id'),
  source_thought_id: text('source_thought_id'),
})

export const tasks = sqliteTable('tasks', {
  ...rowFields(),
  ...provenance(),
  status: text('status').$type<TaskStatus>().notNull(),
  title: text('title').notNull(),
  notes: text('notes'),
  due_at: integer('due_at'),
  priority: text('priority').$type<TaskPriority>(),
  /** Last manual edit/delete (null if never): nothing automatic overwrites it after that. */
  user_edited_at: integer('user_edited_at'),
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
  user_edited_at: integer('user_edited_at'),
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
  user_edited_at: integer('user_edited_at'),
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

/** The thoughts a capture was split into (every one kept). */
export const thoughts = sqliteTable(
  'thoughts',
  {
    ...rowFields(),
    source_bullet_id: text('source_bullet_id').notNull(),
    position: integer('position').notNull(),
    text: text('text').notNull(),
    span_start: integer('span_start'),
    span_end: integer('span_end'),
    kind: text('kind').$type<ThoughtKind>().notNull(),
    kind_source: text('kind_source').$type<'engine' | 'user'>().notNull(),
    /** Open loops (`to_check` / `question`): when resolved, and the note capture that did it. */
    resolved_at: integer('resolved_at'),
    resolved_by_bullet_id: text('resolved_by_bullet_id'),
    // `sensitive` is server-only. Phones that pulled it before still have the column (left
    // unused, defaulted and cleared by migration 0007); it is never read or written here.
    /** "Not this one" on a reflective question about it: never asked about again. */
    never_ask: integer('never_ask', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [index('thoughts_bullet_idx').on(t.source_bullet_id)],
)

/**
 * Questions: clarifying ones about a capture ("To clarify") and reflective ones ("To think
 * about"; an evergreen one has no capture).
 */
export const questions = sqliteTable(
  'questions',
  {
    ...rowFields(),
    source_bullet_id: text('source_bullet_id'),
    source_thought_id: text('source_thought_id'),
    suggestion_id: text('suggestion_id'),
    kind: text('kind').$type<QuestionKind>().notNull().default('clarifying'),
    origin: text('origin').$type<QuestionOrigin>().notNull().default('capture'),
    topic: text('topic').$type<QuestionTopic>().notNull(),
    text: text('text').notNull(),
    options: text('options', { mode: 'json' }).$type<string[]>().notNull(),
    status: text('status').$type<QuestionStatus>().notNull(),
    answer_bullet_id: text('answer_bullet_id'),
    answer_option: text('answer_option'),
    resolved_at: integer('resolved_at'),
    /** Reflective "Later": hidden until then. */
    snoozed_until: integer('snoozed_until'),
    snooze_count: integer('snooze_count').notNull().default(0),
    /** Evergreen questions: which template (`EVERGREEN_QUESTIONS`). */
    template_id: text('template_id'),
    /** Connection questions ("Is this the same thing?"): the earlier thought. */
    related_thought_id: text('related_thought_id'),
  },
  (t) => [index('questions_bullet_idx').on(t.source_bullet_id)],
)

/**
 * Links between thoughts of two captures (slice 3): "Related" on either capture. `a` is the
 * earlier one. Links touching a sensitive thought never reach the phone.
 */
export const thoughtLinks = sqliteTable(
  'thought_links',
  {
    ...rowFields(),
    a_thought_id: text('a_thought_id').notNull(),
    a_bullet_id: text('a_bullet_id').notNull(),
    b_thought_id: text('b_thought_id').notNull(),
    b_bullet_id: text('b_bullet_id').notNull(),
    type: text('type').$type<LinkType>().notNull(),
    /** Which capture(s) show it: `both`, or only `a`'s / `b`'s. */
    visible_from: text('visible_from').$type<LinkVisibility>().notNull().default('both'),
  },
  (t) => [
    index('thought_links_a_bullet_idx').on(t.a_bullet_id),
    index('thought_links_b_bullet_idx').on(t.b_bullet_id),
  ],
)

/** Recurring themes (named in the user's words, or by them). */
export const themes = sqliteTable('themes', {
  ...rowFields(),
  name: text('name'),
  named_by_user: integer('named_by_user', { mode: 'boolean' }).notNull().default(false),
  status: text('status').$type<ThemeStatus>().notNull(),
  merged_into_theme_id: text('merged_into_theme_id'),
  thought_count: integer('thought_count').notNull().default(0),
  day_count: integer('day_count').notNull().default(0),
  first_seen_at: integer('first_seen_at'),
  last_seen_at: integer('last_seen_at'),
})

/** Which thoughts belong to a theme (the Stream's "again" dot). */
export const themeThoughts = sqliteTable(
  'theme_thoughts',
  {
    ...rowFields(),
    theme_id: text('theme_id').notNull(),
    thought_id: text('thought_id').notNull(),
    bullet_id: text('bullet_id').notNull(),
  },
  (t) => [index('theme_thoughts_thought_idx').on(t.thought_id)],
)

/** Noticed cards: "«quote» · came up N times in M days" (never in the badge, never notified). */
export const noticedCards = sqliteTable('noticed_cards', {
  ...rowFields(),
  theme_id: text('theme_id').notNull(),
  headline: text('headline').notNull(),
  quotes: text('quotes', { mode: 'json' }).$type<NoticedQuote[]>().notNull(),
  count: integer('count').notNull(),
  days: integer('days').notNull(),
  status: text('status').$type<NoticedStatus>().notNull(),
  opened_at: integer('opened_at'),
  resolved_at: integer('resolved_at'),
})

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
  thoughts,
  questions,
  thoughtLinks,
  themes,
  themeThoughts,
  noticedCards,
  syncState,
}
