import { z } from 'zod'
import { activitySelectSchema } from './entities/activity'
import {
  audioAttachmentSelectSchema,
  audioMetadataFields,
  audioUploadStatusSchema,
  transcriptSelectSchema,
  transcriptSourceFields,
} from './entities/audio'
import { bulletSelectSchema } from './entities/bullet'
import { eventSelectSchema } from './entities/event'
import {
  noticedCardSelectSchema,
  themeSelectSchema,
  themeThoughtSelectSchema,
  thoughtLinkSelectSchema,
} from './entities/connections'
import { questionSelectSchema } from './entities/question'
import { thoughtKindSchema, thoughtSelectSchema } from './entities/thought'
import { taskSelectSchema } from './entities/task'
import { trackerSelectSchema } from './entities/tracker'
import { trackerEntrySelectSchema, trackerEntryValueSchema } from './entities/trackerEntry'
import { bulletSourceSchema } from './enums'
import { serverBulletProcessingStatusSchema } from './processing'
import { ianaTimezone, nonEmptyString, timestampMs, uuid } from './primitives'
import { suggestionPayloadSchema, suggestionSelectSchema } from './suggestion'

/**
 * The phone ↔ home-server sync contract (docs/contract.md is the readable version).
 *
 *   POST /sync/push              — the phone sends its outbox: an ordered list of operations.
 *   GET  /sync/pull              — the phone asks for everything that changed since its cursor.
 *   PUT  /sync/audio/:id         — upload (part of) a voice recording, resumable by offset.
 *   GET  /sync/audio/:id/status  — how many bytes of it the server already has.
 *   GET  /sync/audio/:id         — download a recording (e.g. to another device).
 *
 * Every request carries `Authorization: Bearer <device token>`.
 *
 * Idempotency: every operation has a client-minted `op_id` (UUID v4). The server remembers the
 * outcome per op_id and answers a replay with `duplicate` instead of doing the work twice, so the
 * phone can resend a batch after any network failure. `bullet.create` is additionally idempotent
 * by the bullet's own client-minted `id`.
 *
 * Stability: new operation types and new change collections may be ADDED later; existing ones
 * keep their meaning. Clients ignore change collections they do not know.
 */

export const SYNC_PROTOCOL_VERSION = 1
export const MAX_PUSH_OPS = 100
export const MAX_PULL_LIMIT = 500

const opBase = {
  /** Client-minted UUID v4, unique per operation; the idempotency key. */
  op_id: uuid(),
} as const

/**
 * The recording behind a voice capture: its metadata (bytes follow via `PUT /sync/audio/:id`)
 * and the live on-device draft transcript.
 */
export const voiceAudioSchema = z.object({
  ...audioMetadataFields,
  draft: z.object(transcriptSourceFields),
})
export type VoiceAudio = z.infer<typeof voiceAudioSchema>

/**
 * A new capture. A voice capture with a recording carries `audio`; its `text` is what the user
 * sent — the draft, or their edit of it (`text_edited_by_user: true`, so the server transcript
 * will not replace it).
 */
export const bulletCreateOpSchema = z.object({
  ...opBase,
  type: z.literal('bullet.create'),
  bullet: z
    .object({
      id: uuid(),
      text: nonEmptyString(),
      captured_at: timestampMs(),
      timezone: ianaTimezone(),
      source: bulletSourceSchema,
      text_edited_by_user: z.boolean().optional(),
      audio: voiceAudioSchema.optional(),
      /**
       * This capture answers a question: a clarifying one, or a reflective one ("Journal about
       * it"; several captures may answer the same reflective question).
       */
      answers_question_id: uuid().optional(),
      /**
       * This capture closes an open loop "with a note": the `to_check` / `question` thought it
       * resolves once the server accepts it. The capture is then processed like any other.
       */
      resolves_thought_id: uuid().optional(),
    })
    .refine((b) => b.audio === undefined || b.source === 'voice', {
      message: "audio requires source 'voice'",
      path: ['audio'],
    }),
})

/**
 * The user changed a bullet's text. Re-runs extraction and reconciles what was applied. Marks the
 * bullet `text_edited_by_user`, so a later server transcript never overwrites it.
 */
export const bulletEditOpSchema = z.object({
  ...opBase,
  type: z.literal('bullet.edit'),
  bullet_id: uuid(),
  text: nonEmptyString(),
  /** Client clock at the edit; an edit older than the server's latest text is rejected `stale`. */
  edited_at: timestampMs(),
})

/**
 * The user deleted a bullet (soft delete).
 *  - cascade          — also remove everything extracted from it ("Delete + extractions").
 *  - keep_extractions — remove only the bullet; tasks/events/entries it produced stay.
 */
export const bulletDeleteModeSchema = z.enum(['cascade', 'keep_extractions'])
export type BulletDeleteMode = z.infer<typeof bulletDeleteModeSchema>

export const bulletDeleteOpSchema = z.object({
  ...opBase,
  type: z.literal('bullet.delete'),
  bullet_id: uuid(),
  mode: bulletDeleteModeSchema,
})

/** The user tapped Retry on a failed bullet. */
export const bulletRetryOpSchema = z.object({
  ...opBase,
  type: z.literal('bullet.retry'),
  bullet_id: uuid(),
})

/** Accept a pending suggestion, optionally with the user's edits to its payload (→ `edited`). */
export const suggestionAcceptOpSchema = z.object({
  ...opBase,
  type: z.literal('suggestion.accept'),
  suggestion_id: uuid(),
  payload: suggestionPayloadSchema.optional(),
})

/** Dismiss a pending suggestion. */
export const suggestionRejectOpSchema = z.object({
  ...opBase,
  type: z.literal('suggestion.reject'),
  suggestion_id: uuid(),
})

/** Undo an applied suggestion (typically an auto-applied one): reverts its effect → `rejected`. */
export const suggestionUndoOpSchema = z.object({
  ...opBase,
  type: z.literal('suggestion.undo'),
  suggestion_id: uuid(),
})

/** The user re-classified a thought (sticky: re-processing never overrides it). */
export const thoughtReclassifyOpSchema = z.object({
  ...opBase,
  type: z.literal('thought.reclassify'),
  thought_id: uuid(),
  kind: thoughtKindSchema,
})

/**
 * The user dismissed a question without answering. On a reflective question this is "Not this
 * one": dismissed for good, and its source thought never produces another question
 * (`never_ask`), even after the capture is processed again.
 */
export const questionDismissOpSchema = z.object({
  ...opBase,
  type: z.literal('question.dismiss'),
  question_id: uuid(),
})

/**
 * "Later" on a reflective question: hidden for a week (`snoozed`, `snoozed_until`). Allowed once;
 * a second "Later" dismisses it quietly (without the "Not this one" consequences). Refused
 * `invalid` for a clarifying question. Answered or dismissed already: a no-op.
 */
export const questionSnoozeOpSchema = z.object({
  ...opBase,
  type: z.literal('question.snooze'),
  question_id: uuid(),
})

/**
 * The user picked an evergreen question to journal about. The phone mints the question's id and
 * shows it at once (so it can be answered offline); the server creates the same open reflective
 * question. A pick may go one over the open cap (4 open at most); the user asked, so the daily
 * cap, the quiet and sensitive pauses don't hold it back (it still counts toward the day's new
 * questions). Refused `invalid` for an unknown template, `conflict` when 4 reflective questions
 * are already open; the phone then drops its local copy. The same question id again is a
 * `duplicate`.
 */
export const questionPickEvergreenOpSchema = z.object({
  ...opBase,
  type: z.literal('question.pick_evergreen'),
  /** Client-minted id of the new question. */
  question_id: uuid(),
  template_id: nonEmptyString(),
})

/**
 * The user answered a clarifying question by tapping one of its `options` (no model call), or a
 * reflective `connection` question ("Same thing" links the two thoughts; "Different" records that
 * they are not, like `link.veto`):
 *  - `date`        — the option's day is set on the linked task/event suggestion, which is then
 *                    applied (or, if it already was, its result is moved to that day).
 *  - `new_tracker` — "Yes" accepts the linked tracker suggestion (that tap is the confirmation a
 *                    definition always needs); "No" dismisses it.
 *  - `other`       — the answer is recorded; nothing else changes.
 * The question becomes `answered` with `answer_option`. Re-sending the same answer is a no-op.
 * Other reflective questions have no options: answering one this way is refused `invalid`.
 */
export const questionAnswerOpSchema = z.object({
  ...opBase,
  type: z.literal('question.answer'),
  question_id: uuid(),
  /** Exactly one of the question's `options`. */
  option: nonEmptyString(),
})

/** Close an open loop: a `to_check` or `question` thought (others are refused `invalid`). */
export const thoughtResolveOpSchema = z.object({
  ...opBase,
  type: z.literal('thought.resolve'),
  thought_id: uuid(),
})

/** Re-open a resolved thought. */
export const thoughtUnresolveOpSchema = z.object({
  ...opBase,
  type: z.literal('thought.unresolve'),
  thought_id: uuid(),
})

/**
 * Light manual editing (slice 1: edit and delete what the app extracted; no manual creation).
 * A patch carries only the fields that change, unknown keys are refused, and at least one field is
 * required. Every manual edit or delete stamps the row's `user_edited_at`, so reprocessing never
 * overwrites it and undoing the suggestion that produced it is refused (`conflict`).
 */
const manualPatch = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object(shape)
    .partial()
    .strict()
    .refine((p) => Object.keys(p).length > 0, { message: 'a patch must change at least one field' })

/** Complete (`done`) / reopen (`todo`), reschedule or clear the due date, rename. */
export const taskManualPatchSchema = manualPatch({
  status: z.enum(['todo', 'done']),
  title: nonEmptyString(),
  due_at: timestampMs().nullable(),
})
export type TaskManualPatch = z.infer<typeof taskManualPatchSchema>

/** Move or rename. The result must still end no earlier than it starts. */
export const eventManualPatchSchema = manualPatch({
  title: nonEmptyString(),
  starts_at: timestampMs(),
  ends_at: timestampMs().nullable(),
})
export type EventManualPatch = z.infer<typeof eventManualPatchSchema>

/** Correct a reading. The value must fit its tracker's input type and config. */
export const trackerEntryManualPatchSchema = z.object({ value: trackerEntryValueSchema }).strict()
export type TrackerEntryManualPatch = z.infer<typeof trackerEntryManualPatchSchema>

export const taskUpdateOpSchema = z.object({
  ...opBase,
  type: z.literal('task.update'),
  task_id: uuid(),
  patch: taskManualPatchSchema,
})

/** Soft-delete a task. */
export const taskDeleteOpSchema = z.object({
  ...opBase,
  type: z.literal('task.delete'),
  task_id: uuid(),
})

export const eventUpdateOpSchema = z.object({
  ...opBase,
  type: z.literal('event.update'),
  event_id: uuid(),
  patch: eventManualPatchSchema,
})

/** Soft-delete an event. */
export const eventDeleteOpSchema = z.object({
  ...opBase,
  type: z.literal('event.delete'),
  event_id: uuid(),
})

export const trackerEntryUpdateOpSchema = z.object({
  ...opBase,
  type: z.literal('tracker_entry.update'),
  tracker_entry_id: uuid(),
  patch: trackerEntryManualPatchSchema,
})

/** Soft-delete a tracker reading. */
export const trackerEntryDeleteOpSchema = z.object({
  ...opBase,
  type: z.literal('tracker_entry.delete'),
  tracker_entry_id: uuid(),
})

// --- connections, themes, Noticed (slice 3) ---

/**
 * "Not related": the link is deleted and the pair is remembered (both directions), so nothing
 * links those two thoughts again: not the next capture, a nightly run, an edit or re-processing.
 * Already deleted: a no-op.
 */
export const linkVetoOpSchema = z.object({
  ...opBase,
  type: z.literal('link.veto'),
  link_id: uuid(),
})

/** Rename a theme. The user's name is what shows from then on (the model's is kept, unseen). */
export const themeRenameOpSchema = z.object({
  ...opBase,
  type: z.literal('theme.rename'),
  theme_id: uuid(),
  name: nonEmptyString().max(60),
})

/**
 * "Not a theme": the theme is retired, never re-created from the same thoughts, and its unopened
 * cards are withdrawn. Its links stay.
 */
export const themeRetireOpSchema = z.object({
  ...opBase,
  type: z.literal('theme.retire'),
  theme_id: uuid(),
})

/**
 * "Merge with…": `theme_id`'s thoughts move to `into_theme_id`, `theme_id` is retired (pointing
 * at the survivor), and later nightly matches of it fold into the survivor.
 */
export const themeMergeOpSchema = z.object({
  ...opBase,
  type: z.literal('theme.merge'),
  theme_id: uuid(),
  into_theme_id: uuid(),
})

/** The user opened a Noticed card. */
export const noticedOpenOpSchema = z.object({
  ...opBase,
  type: z.literal('noticed.open'),
  card_id: uuid(),
})

/** The user dismissed a Noticed card. */
export const noticedDismissOpSchema = z.object({
  ...opBase,
  type: z.literal('noticed.dismiss'),
  card_id: uuid(),
})

export const pushOpSchema = z.discriminatedUnion('type', [
  bulletCreateOpSchema,
  bulletEditOpSchema,
  bulletDeleteOpSchema,
  bulletRetryOpSchema,
  suggestionAcceptOpSchema,
  suggestionRejectOpSchema,
  suggestionUndoOpSchema,
  thoughtReclassifyOpSchema,
  questionDismissOpSchema,
  questionAnswerOpSchema,
  questionSnoozeOpSchema,
  questionPickEvergreenOpSchema,
  thoughtResolveOpSchema,
  thoughtUnresolveOpSchema,
  taskUpdateOpSchema,
  taskDeleteOpSchema,
  eventUpdateOpSchema,
  eventDeleteOpSchema,
  trackerEntryUpdateOpSchema,
  trackerEntryDeleteOpSchema,
  linkVetoOpSchema,
  themeRenameOpSchema,
  themeRetireOpSchema,
  themeMergeOpSchema,
  noticedOpenOpSchema,
  noticedDismissOpSchema,
])
export type PushOp = z.infer<typeof pushOpSchema>
export type PushOpType = PushOp['type']

export const pushRequestSchema = z.object({
  ops: z.array(pushOpSchema).min(1).max(MAX_PUSH_OPS),
})
export type PushRequest = z.infer<typeof pushRequestSchema>

/**
 * Why the server refused an operation. A refused op is final: the phone drops it from its outbox
 * (retrying would get the same answer) and the next pull brings the server's truth.
 *
 *  - not_found — the bullet/suggestion does not exist (or belongs to someone else).
 *  - invalid   — the operation is well-formed JSON but not valid against current state
 *                (e.g. accepting an already-rejected suggestion, an edited payload that fails
 *                validation, a create re-using an id with different content, editing something
 *                deleted, a reading that doesn't fit its tracker, resolving a `note` thought, or
 *                an option the question doesn't offer).
 *  - conflict  — the target changed since (e.g. undo after the user edited the task by hand, or
 *                answering a question whose suggestion was dismissed meanwhile).
 *  - stale     — an edit older than the text the server already has.
 */
export const pushRejectCodeSchema = z.enum(['not_found', 'invalid', 'conflict', 'stale'])
export type PushRejectCode = z.infer<typeof pushRejectCodeSchema>

/**
 * Per-op outcome, in request order.
 *  - applied   — done now.
 *  - duplicate — this op_id (or this bullet id, for bullet.create) was already handled; no-op.
 *  - rejected  — refused for good; see `error`.
 */
export const pushOpResultSchema = z.discriminatedUnion('status', [
  z.object({ op_id: uuid(), status: z.literal('applied') }),
  z.object({ op_id: uuid(), status: z.literal('duplicate') }),
  z.object({
    op_id: uuid(),
    status: z.literal('rejected'),
    error: z.object({ code: pushRejectCodeSchema, message: z.string() }),
  }),
])
export type PushOpResult = z.infer<typeof pushOpResultSchema>

export const pushResponseSchema = z.object({
  results: z.array(pushOpResultSchema),
  server_time: timestampMs(),
})
export type PushResponse = z.infer<typeof pushResponseSchema>

/**
 * Pull query. `cursor` is opaque: send back exactly what the last pull returned; omit it for a
 * full sync from scratch.
 */
export const pullQuerySchema = z.object({
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PULL_LIMIT).optional(),
})
export type PullQuery = z.infer<typeof pullQuerySchema>

/** A bullet as the server sends it: the processing status is never `saved_local`. */
export const syncedBulletSchema = bulletSelectSchema.extend({
  processing: bulletSelectSchema.shape.processing.extend({
    status: serverBulletProcessingStatusSchema,
  }),
})
export type SyncedBullet = z.infer<typeof syncedBulletSchema>

/**
 * A thought as the server sends it: without `sensitive`, which is server-only (it only keeps
 * reflective questions away and is never shown, so it never leaves the home server). An older
 * server's extra `sensitive` key is stripped when the phone parses the pull.
 */
export const syncedThoughtSchema = thoughtSelectSchema.omit({ sensitive: true })
export type SyncedThought = z.infer<typeof syncedThoughtSchema>

/**
 * Everything that changed since the cursor: full current rows (not diffs), including rows that
 * were soft-deleted (`state: 'deleted'`) so the phone can hide them. A row appears at most once per
 * response, in its latest version.
 */
export const pullChangesSchema = z.object({
  bullets: z.array(syncedBulletSchema),
  suggestions: z.array(suggestionSelectSchema),
  tasks: z.array(taskSelectSchema),
  events: z.array(eventSelectSchema),
  trackers: z.array(trackerSelectSchema),
  tracker_entries: z.array(trackerEntrySelectSchema),
  activities: z.array(activitySelectSchema),
  audio_attachments: z.array(audioAttachmentSelectSchema),
  transcripts: z.array(transcriptSelectSchema),
  thoughts: z.array(syncedThoughtSchema),
  questions: z.array(questionSelectSchema),
  // Slice 3. Defaulted, so a phone can still read an older server's pull.
  thought_links: z.array(thoughtLinkSelectSchema).default([]),
  themes: z.array(themeSelectSchema).default([]),
  theme_thoughts: z.array(themeThoughtSelectSchema).default([]),
  noticed_cards: z.array(noticedCardSelectSchema).default([]),
})
export type PullChanges = z.infer<typeof pullChangesSchema>
export type PullChangeKind = keyof PullChanges

export const pullResponseSchema = z.object({
  changes: pullChangesSchema,
  /** Pass this back as `cursor` on the next pull. */
  cursor: z.string(),
  /** True when more changes are waiting: pull again immediately with the new cursor. */
  has_more: z.boolean(),
  server_time: timestampMs(),
})
export type PullResponse = z.infer<typeof pullResponseSchema>

/** Upload headers: the byte offset this request's body starts at (tus-style). */
export const AUDIO_UPLOAD_OFFSET_HEADER = 'upload-offset'
/** Largest body accepted per `PUT /sync/audio/:id` request; bigger files go in several. */
export const MAX_AUDIO_CHUNK_BYTES = 4 * 1024 * 1024

/**
 * Upload protocol (idempotent by attachment id, resumable):
 *  1. `bullet.create` declares the recording (id, size, sha256). Upload only after it is acked.
 *  2. `GET /sync/audio/:id/status` → `received_bytes`.
 *  3. `PUT /sync/audio/:id` with header `upload-offset: <received_bytes>` and the next bytes as
 *     an `application/octet-stream` body. A wrong offset answers 409; re-read the status and resend
 *     from there. The request completing the file verifies sha256 (if given): a mismatch answers
 *     422 and resets the upload to 0.
 *  4. Re-sending a completed upload answers 200 `uploaded` without changing anything.
 */
export const audioUploadStateSchema = z.object({
  attachment_id: uuid(),
  size_bytes: z.number().int().positive(),
  received_bytes: z.number().int().nonnegative(),
  upload_status: audioUploadStatusSchema,
})
export type AudioUploadState = z.infer<typeof audioUploadStateSchema>

/** The error envelope every non-2xx response uses. */
export const apiErrorCodeSchema = z.enum([
  'unauthorized',
  'bad_request',
  'not_found',
  'conflict',
  'payload_too_large',
  'unprocessable',
  'internal',
])
export const apiErrorSchema = z.object({
  error: z.object({ code: apiErrorCodeSchema, message: z.string() }),
})
export type ApiError = z.infer<typeof apiErrorSchema>
