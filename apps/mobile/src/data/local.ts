/**
 * Local writes. Every user action changes the local database AND appends its outbox op in ONE
 * transaction, so a change can never exist without the op that will sync it (or vice versa).
 * The UI reflects the change at once; the server's answer arrives with the next pull.
 */

import {
  type BulletDeleteMode,
  type BulletSource,
  type EventManualPatch,
  entryValueFits,
  eventManualPatchSchema,
  type PushOp,
  RESOLVABLE_THOUGHT_KINDS,
  type SuggestionPayload,
  type TaskManualPatch,
  type ThoughtKind,
  type TrackerEntryValue,
  taskManualPatchSchema,
  trackerEntryValueSchema,
} from '@bullet/core'
import { dateAnswerFields, yesNoAnswer } from '@bullet/engine'
import { and, eq, isNull } from 'drizzle-orm'
import type { PhoneDb } from './db'
import { ENTITY_TABLES } from './mirror'
import {
  audioAttachments,
  bullets,
  events,
  outbox,
  questions,
  suggestions,
  tasks,
  thoughts,
  trackerEntries,
  trackers,
  transcripts,
} from './schema'

/** Injected so pure logic stays testable: the device clock, UUIDs and time zone. */
export interface LocalDeps {
  now: () => number
  uuid: () => string
  timezone: () => string
}

function appendOp(
  db: PhoneDb,
  op: PushOp,
  refs: {
    bullet_id?: string
    suggestion_id?: string
    thought_id?: string
    question_id?: string
    entity_id?: string
  },
  now: number,
) {
  db.insert(outbox)
    .values({
      op_id: op.op_id,
      type: op.type,
      bullet_id: refs.bullet_id ?? null,
      suggestion_id: refs.suggestion_id ?? null,
      thought_id: refs.thought_id ?? null,
      question_id: refs.question_id ?? null,
      entity_id: refs.entity_id ?? null,
      op,
      created_at: now,
    })
    .run()
}

export interface CaptureInput extends CaptureLinks {
  text: string
  source?: BulletSource
}

/** What a capture links to: it answers a question or closes an open loop "with a note". */
export interface CaptureLinks {
  /** This capture answers a clarifying question. */
  answersQuestionId?: string
  /** This capture closes an open-loop thought "with a note" (it is resolved at once, locally). */
  resolvesThoughtId?: string
}

function linkFields(links: CaptureLinks) {
  return {
    ...(links.answersQuestionId ? { answers_question_id: links.answersQuestionId } : {}),
    ...(links.resolvesThoughtId ? { resolves_thought_id: links.resolvesThoughtId } : {}),
  }
}

/** Mirror locally what the server does for a linked capture: answer the question, close the loop. */
function applyLinks(db: PhoneDb, links: CaptureLinks, bulletId: string, now: number) {
  if (links.answersQuestionId) {
    db.update(questions)
      .set({ status: 'answered', answer_bullet_id: bulletId, resolved_at: now, updated_at: now })
      .where(eq(questions.id, links.answersQuestionId))
      .run()
  }
  if (links.resolvesThoughtId) {
    db.update(thoughts)
      .set({ resolved_at: now, resolved_by_bullet_id: bulletId, updated_at: now })
      .where(and(eq(thoughts.id, links.resolvesThoughtId), isNull(thoughts.resolved_at)))
      .run()
  }
}

/** Save a capture on the device (status `saved_local`) and queue it for sync. Returns its id. */
export function captureBullet(db: PhoneDb, input: CaptureInput, deps: LocalDeps): string {
  const text = input.text.trim()
  if (text === '') throw new Error('cannot capture an empty bullet')
  const now = deps.now()
  const id = deps.uuid()
  const bullet = {
    id,
    text,
    captured_at: now,
    timezone: deps.timezone(),
    source: input.source ?? 'text',
    ...linkFields(input),
  }
  db.transaction((tx) => {
    tx.insert(bullets)
      .values({ ...bullet, created_at: now, updated_at: now })
      .run()
    applyLinks(tx, input, id, now)
    appendOp(
      tx,
      { op_id: deps.uuid(), type: 'bullet.create', bullet },
      {
        bullet_id: id,
        ...(input.resolvesThoughtId ? { thought_id: input.resolvesThoughtId } : {}),
      },
      now,
    )
  })
  return id
}

export interface VoiceCaptureInput extends CaptureLinks {
  /** What the user sends: the live draft, or their edit of it. */
  text: string
  /** True when the user changed the draft before sending: the server transcript won't replace it. */
  textEditedByUser: boolean
  /** The recording, already written to a file by the recorder. */
  audio: {
    localPath: string
    mimeType: string
    durationMs: number
    sizeBytes: number
    sha256: string | null
  }
  /** The live on-device transcript (Apple SFSpeechRecognizer, on-device only). */
  draft: { text: string; engine: string; model: string | null; languages: string[] }
}

/**
 * Save a voice capture: the bullet, its recording (kept permanently), the device draft transcript
 * and the outbox op — all in one transaction. The audio bytes upload after the op is acked.
 */
export function captureVoiceBullet(db: PhoneDb, input: VoiceCaptureInput, deps: LocalDeps): string {
  const text = input.text.trim()
  if (text === '') throw new Error('cannot capture an empty bullet')
  const now = deps.now()
  const id = deps.uuid()
  const audioId = deps.uuid()
  const a = input.audio
  const bullet = {
    id,
    text,
    captured_at: now,
    timezone: deps.timezone(),
    source: 'voice' as const,
    text_edited_by_user: input.textEditedByUser,
    ...linkFields(input),
  }
  db.transaction((tx) => {
    tx.insert(bullets)
      .values({ ...bullet, created_at: now, updated_at: now })
      .run()
    tx.insert(audioAttachments)
      .values({
        id: audioId,
        bullet_id: id,
        mime_type: a.mimeType,
        duration_ms: a.durationMs,
        size_bytes: a.sizeBytes,
        sha256: a.sha256,
        local_path: a.localPath,
        upload_status: 'pending',
        created_at: now,
        updated_at: now,
      })
      .run()
    tx.insert(transcripts)
      .values({
        id: deps.uuid(),
        bullet_id: id,
        attachment_id: audioId,
        kind: 'device_draft',
        ...input.draft,
        transcribed_at: now,
        created_at: now,
        updated_at: now,
      })
      .run()
    applyLinks(tx, input, id, now)
    appendOp(
      tx,
      {
        op_id: deps.uuid(),
        type: 'bullet.create',
        bullet: {
          ...bullet,
          audio: {
            id: audioId,
            mime_type: a.mimeType,
            duration_ms: a.durationMs,
            size_bytes: a.sizeBytes,
            sha256: a.sha256,
            draft: input.draft,
          },
        },
      },
      {
        bullet_id: id,
        ...(input.resolvesThoughtId ? { thought_id: input.resolvesThoughtId } : {}),
      },
      now,
    )
  })
  return id
}

export function editBullet(db: PhoneDb, bulletId: string, text: string, deps: LocalDeps): void {
  const next = text.trim()
  if (next === '') throw new Error('cannot save an empty bullet')
  const now = deps.now()
  db.transaction((tx) => {
    tx.update(bullets)
      .set({ text: next, text_edited_by_user: true, updated_at: now, sync_rejection: null })
      .where(eq(bullets.id, bulletId))
      .run()
    appendOp(
      tx,
      { op_id: deps.uuid(), type: 'bullet.edit', bullet_id: bulletId, text: next, edited_at: now },
      { bullet_id: bulletId },
      now,
    )
  })
}

/** Soft-delete locally (mirroring what the server will do) and queue the delete. */
export function deleteBullet(
  db: PhoneDb,
  bulletId: string,
  mode: BulletDeleteMode,
  deps: LocalDeps,
): void {
  const now = deps.now()
  db.transaction((tx) => {
    tx.update(bullets)
      .set({ state: 'deleted', updated_at: now })
      .where(eq(bullets.id, bulletId))
      .run()
    // The recording + transcripts go with the bullet (soft delete; the file is kept).
    tx.update(audioAttachments)
      .set({ state: 'deleted', updated_at: now })
      .where(eq(audioAttachments.bullet_id, bulletId))
      .run()
    tx.update(transcripts)
      .set({ state: 'deleted', updated_at: now })
      .where(eq(transcripts.bullet_id, bulletId))
      .run()
    for (const table of [thoughts, questions]) {
      tx.update(table)
        .set({ state: 'deleted', updated_at: now })
        .where(eq(table.source_bullet_id, bulletId))
        .run()
    }
    const own = eq(suggestions.source_bullet_id, bulletId)
    tx.update(suggestions)
      .set({ state: 'deleted', updated_at: now })
      .where(mode === 'cascade' ? own : and(own, eq(suggestions.status, 'pending')))
      .run()
    if (mode === 'cascade') {
      for (const table of Object.values(ENTITY_TABLES)) {
        tx.update(table)
          .set({ state: 'deleted', updated_at: now })
          .where(eq(table.source_bullet_id, bulletId))
          .run()
      }
    }
    appendOp(
      tx,
      { op_id: deps.uuid(), type: 'bullet.delete', bullet_id: bulletId, mode },
      { bullet_id: bulletId },
      now,
    )
  })
}

export function retryBullet(db: PhoneDb, bulletId: string, deps: LocalDeps): void {
  const now = deps.now()
  db.transaction((tx) => {
    appendOp(
      tx,
      { op_id: deps.uuid(), type: 'bullet.retry', bullet_id: bulletId },
      { bullet_id: bulletId },
      now,
    )
  })
}

export function acceptSuggestion(
  db: PhoneDb,
  suggestionId: string,
  deps: LocalDeps,
  payload?: SuggestionPayload,
): void {
  const now = deps.now()
  db.transaction((tx) => {
    tx.update(suggestions)
      .set({
        status: payload ? 'edited' : 'accepted',
        resolved_at: now,
        updated_at: now,
        ...(payload ? { payload } : {}),
      })
      .where(eq(suggestions.id, suggestionId))
      .run()
    appendOp(
      tx,
      {
        op_id: deps.uuid(),
        type: 'suggestion.accept',
        suggestion_id: suggestionId,
        ...(payload ? { payload } : {}),
      },
      { suggestion_id: suggestionId },
      now,
    )
  })
}

export function rejectSuggestion(db: PhoneDb, suggestionId: string, deps: LocalDeps): void {
  const now = deps.now()
  db.transaction((tx) => {
    tx.update(suggestions)
      .set({ status: 'rejected', resolved_at: now, updated_at: now })
      .where(eq(suggestions.id, suggestionId))
      .run()
    appendOp(
      tx,
      { op_id: deps.uuid(), type: 'suggestion.reject', suggestion_id: suggestionId },
      { suggestion_id: suggestionId },
      now,
    )
  })
}

/** Undo an applied (typically auto-applied) suggestion. */
export function undoSuggestion(db: PhoneDb, suggestionId: string, deps: LocalDeps): void {
  const now = deps.now()
  db.transaction((tx) => {
    const s = tx.select().from(suggestions).where(eq(suggestions.id, suggestionId)).get()
    if (s?.applied_entity_id && s.operation !== 'update') {
      const table = ENTITY_TABLES[s.target_kind]
      tx.update(table)
        .set({ state: 'deleted', updated_at: now })
        .where(eq(table.id, s.applied_entity_id))
        .run()
    }
    tx.update(suggestions)
      .set({
        status: 'rejected',
        resolved_at: now,
        applied_entity_id: null,
        applied_at: null,
        updated_at: now,
      })
      .where(eq(suggestions.id, suggestionId))
      .run()
    appendOp(
      tx,
      { op_id: deps.uuid(), type: 'suggestion.undo', suggestion_id: suggestionId },
      { suggestion_id: suggestionId },
      now,
    )
  })
}

/** Re-classify a thought (sticky on the server: re-processing never overrides it). */
export function reclassifyThought(
  db: PhoneDb,
  thoughtId: string,
  kind: ThoughtKind,
  deps: LocalDeps,
): void {
  const now = deps.now()
  db.transaction((tx) => {
    tx.update(thoughts)
      .set({ kind, kind_source: 'user', updated_at: now })
      .where(eq(thoughts.id, thoughtId))
      .run()
    appendOp(
      tx,
      { op_id: deps.uuid(), type: 'thought.reclassify', thought_id: thoughtId, kind },
      { thought_id: thoughtId },
      now,
    )
  })
}

/** Dismiss a clarifying question without answering. */
export function dismissQuestion(db: PhoneDb, questionId: string, deps: LocalDeps): void {
  const now = deps.now()
  db.transaction((tx) => {
    tx.update(questions)
      .set({ status: 'dismissed', resolved_at: now, updated_at: now })
      .where(eq(questions.id, questionId))
      .run()
    appendOp(
      tx,
      { op_id: deps.uuid(), type: 'question.dismiss', question_id: questionId },
      { question_id: questionId },
      now,
    )
  })
}

/** Close an open loop (a `to_check` / `question` thought). Throws for any other kind. */
export function resolveThought(db: PhoneDb, thoughtId: string, deps: LocalDeps): void {
  const now = deps.now()
  db.transaction((tx) => {
    const t = tx.select().from(thoughts).where(eq(thoughts.id, thoughtId)).get()
    if (!t || t.state !== 'active') throw new Error(`thought ${thoughtId} not found`)
    if (!(RESOLVABLE_THOUGHT_KINDS as readonly ThoughtKind[]).includes(t.kind)) {
      throw new Error(`a ${t.kind} thought is not an open loop`)
    }
    if (t.resolved_at === null) {
      tx.update(thoughts)
        .set({ resolved_at: now, resolved_by_bullet_id: null, updated_at: now })
        .where(eq(thoughts.id, thoughtId))
        .run()
    }
    appendOp(
      tx,
      { op_id: deps.uuid(), type: 'thought.resolve', thought_id: thoughtId },
      { thought_id: thoughtId },
      now,
    )
  })
}

/** Re-open a resolved thought. */
export function unresolveThought(db: PhoneDb, thoughtId: string, deps: LocalDeps): void {
  const now = deps.now()
  db.transaction((tx) => {
    tx.update(thoughts)
      .set({ resolved_at: null, resolved_by_bullet_id: null, updated_at: now })
      .where(eq(thoughts.id, thoughtId))
      .run()
    appendOp(
      tx,
      { op_id: deps.uuid(), type: 'thought.unresolve', thought_id: thoughtId },
      { thought_id: thoughtId },
      now,
    )
  })
}

/**
 * Answer a clarifying question by tapping one of its options. Shown at once: the question is
 * answered and its suggestion accepted (a `date` answer also moves the task/event's date; a
 * `new_tracker` "No" dismisses it). The server applies it for real; the next pull brings that.
 */
export function answerQuestion(
  db: PhoneDb,
  questionId: string,
  option: string,
  deps: LocalDeps,
): void {
  const now = deps.now()
  db.transaction((tx) => {
    const q = tx.select().from(questions).where(eq(questions.id, questionId)).get()
    if (!q || q.state !== 'active') throw new Error(`question ${questionId} not found`)
    if (!q.options.includes(option)) throw new Error(`"${option}" is not an option`)
    tx.update(questions)
      .set({ status: 'answered', answer_option: option, resolved_at: now, updated_at: now })
      .where(eq(questions.id, questionId))
      .run()

    const refs: Parameters<typeof appendOp>[2] = { question_id: questionId }
    const s = q.suggestion_id
      ? tx.select().from(suggestions).where(eq(suggestions.id, q.suggestion_id)).get()
      : undefined
    if (s && s.state === 'active') {
      refs.suggestion_id = s.id
      const setSuggestion = (patch: Partial<typeof suggestions.$inferInsert>) =>
        tx
          .update(suggestions)
          .set({ ...patch, updated_at: now })
          .where(eq(suggestions.id, s.id))
          .run()
      if (q.topic === 'date' && (s.target_kind === 'task' || s.target_kind === 'event')) {
        const kind = s.target_kind
        const b = tx.select().from(bullets).where(eq(bullets.id, s.source_bullet_id)).get()
        const ctx = { capturedAt: b?.captured_at ?? now, timezone: b?.timezone ?? deps.timezone() }
        if (s.status === 'pending') {
          const fields = dateAnswerFields(kind, s.payload, option, ctx)
          if (fields) {
            const payload = { ...s.payload, ...fields }
            const edited = JSON.stringify(payload) !== JSON.stringify(s.payload)
            setSuggestion({ status: edited ? 'edited' : 'accepted', payload, resolved_at: now })
          }
        } else if (s.applied_entity_id) {
          const table = kind === 'task' ? tasks : events
          const row = tx.select().from(table).where(eq(table.id, s.applied_entity_id)).get()
          const fields = row ? dateAnswerFields(kind, row, option, ctx) : null
          if (row && fields) {
            tx.update(table)
              .set({ ...fields, updated_at: now })
              .where(eq(table.id, row.id))
              .run()
            setSuggestion({ payload: { ...s.payload, ...fields } })
            refs.entity_id = row.id
          }
        }
      } else if (q.topic === 'new_tracker' && s.status === 'pending') {
        const yes = yesNoAnswer(option)
        if (yes !== null) setSuggestion({ status: yes ? 'accepted' : 'rejected', resolved_at: now })
      }
    }
    appendOp(
      tx,
      { op_id: deps.uuid(), type: 'question.answer', question_id: questionId, option },
      refs,
      now,
    )
  })
}

// --- light manual editing: tasks, events, tracker entries (no manual creation in slice 1) ---

type ManualTable = typeof tasks

/**
 * Write a hand edit (or delete) locally — stamping `user_edited_at` like the server will — and
 * queue its op, in one transaction. Throws when the row is unknown or already deleted.
 */
function editByHand(
  db: PhoneDb,
  table: unknown,
  id: string,
  fields: Record<string, unknown>,
  check: (row: Record<string, unknown>) => void,
  op: PushOp,
  deps: LocalDeps,
): void {
  const t = table as ManualTable
  const now = deps.now()
  db.transaction((tx) => {
    const row = tx.select().from(t).where(eq(t.id, id)).get() as Record<string, unknown> | undefined
    if (!row || row.state !== 'active') throw new Error(`${op.type}: ${id} not found`)
    check({ ...row, ...fields })
    tx.update(t)
      .set({ ...fields, user_edited_at: now, updated_at: now } as Partial<
        ManualTable['$inferInsert']
      >)
      .where(eq(t.id, id))
      .run()
    appendOp(tx, op, { entity_id: id }, now)
  })
}

const noCheck = () => {}

/** Complete / reopen (`status: 'done' | 'todo'`), reschedule (`due_at`, null clears) or rename. */
export function updateTask(
  db: PhoneDb,
  taskId: string,
  patch: TaskManualPatch,
  deps: LocalDeps,
): void {
  const p = taskManualPatchSchema.parse(patch)
  const op: PushOp = { op_id: deps.uuid(), type: 'task.update', task_id: taskId, patch: p }
  editByHand(db, tasks, taskId, p, noCheck, op, deps)
}

export function deleteTask(db: PhoneDb, taskId: string, deps: LocalDeps): void {
  const op: PushOp = { op_id: deps.uuid(), type: 'task.delete', task_id: taskId }
  editByHand(db, tasks, taskId, { state: 'deleted' }, noCheck, op, deps)
}

/** Move (`starts_at`, `ends_at`; null clears the end) or rename. Throws if it would end first. */
export function updateEvent(
  db: PhoneDb,
  eventId: string,
  patch: EventManualPatch,
  deps: LocalDeps,
): void {
  const p = eventManualPatchSchema.parse(patch)
  const op: PushOp = { op_id: deps.uuid(), type: 'event.update', event_id: eventId, patch: p }
  const check = (e: Record<string, unknown>) => {
    if (typeof e.ends_at === 'number' && e.ends_at < Number(e.starts_at)) {
      throw new Error('an event cannot end before it starts')
    }
  }
  editByHand(db, events, eventId, p, check, op, deps)
}

export function deleteEvent(db: PhoneDb, eventId: string, deps: LocalDeps): void {
  const op: PushOp = { op_id: deps.uuid(), type: 'event.delete', event_id: eventId }
  editByHand(db, events, eventId, { state: 'deleted' }, noCheck, op, deps)
}

/** Correct a reading. Throws when the value doesn't fit its tracker. */
export function updateTrackerEntry(
  db: PhoneDb,
  entryId: string,
  value: TrackerEntryValue,
  deps: LocalDeps,
): void {
  const v = trackerEntryValueSchema.parse(value)
  const op: PushOp = {
    op_id: deps.uuid(),
    type: 'tracker_entry.update',
    tracker_entry_id: entryId,
    patch: { value: v },
  }
  const check = (e: Record<string, unknown>) => {
    const tracker = db
      .select()
      .from(trackers)
      .where(eq(trackers.id, String(e.tracker_id)))
      .get()
    if (tracker && !entryValueFits(v, tracker.config)) {
      throw new Error(`value does not fit tracker "${tracker.name}"`)
    }
  }
  editByHand(db, trackerEntries, entryId, { value: v }, check, op, deps)
}

export function deleteTrackerEntry(db: PhoneDb, entryId: string, deps: LocalDeps): void {
  const op: PushOp = { op_id: deps.uuid(), type: 'tracker_entry.delete', tracker_entry_id: entryId }
  editByHand(db, trackerEntries, entryId, { state: 'deleted' }, noCheck, op, deps)
}
