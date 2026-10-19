/**
 * Answering a clarifying question by tapping one of its options (`question.answer`). No model
 * call: the answer acts on the question's suggestion deterministically, in the push transaction.
 *
 *  - date        — the tapped day goes on the task (`due_at`) / event (`starts_at`, `ends_at`
 *                  moved along) the suggestion proposes, keeping its time of day; then it is
 *                  applied. Already applied (and not changed since): its result is moved instead.
 *  - new_tracker — "Yes" accepts the tracker suggestion (the user's confirmation a definition
 *                  always needs); "No" rejects it.
 *  - other       — only recorded.
 *
 * The question becomes `answered` with `answer_option`. The same answer again is a `duplicate`.
 */

import { dateAnswerFields, yesNoAnswer } from '@bullet/engine'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { bullets, questions } from '../db/schema'
import { getQuestion } from '../capture/thoughts'
import { touch } from '../sync/changes'
import {
  ApplyError,
  applySuggestion,
  settleTrackerQuestions,
  getSuggestion,
  refreshReviewStatus,
  rejectSuggestion,
  type SuggestionRow,
  updateSuggestionRow,
} from './apply'
import { getEntity, patchEntity } from './entities'

function linkedSuggestion(db: Db, ownerId: string, id: string | null): SuggestionRow {
  const s = id === null ? undefined : getSuggestion(db, ownerId, id)
  if (!s) throw new ApplyError('invalid', 'the question is not about a suggestion')
  if (s.state !== 'active') throw new ApplyError('conflict', 'its suggestion was withdrawn')
  return s
}

function answerDate(db: Db, ownerId: string, s: SuggestionRow, option: string, now: number) {
  if ((s.target_kind !== 'task' && s.target_kind !== 'event') || s.operation !== 'create') {
    throw new ApplyError('invalid', 'a date answer needs a new task or event')
  }
  const kind = s.target_kind
  const bullet = db
    .select({ captured_at: bullets.captured_at, timezone: bullets.timezone })
    .from(bullets)
    .where(and(eq(bullets.id, s.source_bullet_id), eq(bullets.owner_id, ownerId)))
    .get()
  if (!bullet) throw new ApplyError('not_found', 'capture not found')
  const ctx = { capturedAt: bullet.captured_at, timezone: bullet.timezone }

  if (s.status === 'pending') {
    const fields = dateAnswerFields(kind, s.payload, option, ctx)
    if (fields === null) throw new ApplyError('invalid', `"${option}" names no date`)
    applySuggestion(db, s, now, { payload: { ...s.payload, ...fields } })
    refreshReviewStatus(db, ownerId, s.source_bullet_id, now)
    return
  }
  if (s.status === 'rejected' || s.applied_entity_id === null || s.applied_at === null) {
    throw new ApplyError('conflict', 'its suggestion is no longer waiting')
  }
  // Applied already (e.g. accepted on another device): move what it created, unless the user has
  // changed that since. The move is part of the suggestion, so its Undo keeps working.
  const entity = getEntity(db, kind, ownerId, s.applied_entity_id)
  if (!entity || entity.state !== 'active' || entity.updated_at > s.applied_at) {
    throw new ApplyError('conflict', `the ${kind} was changed since`)
  }
  const fields = dateAnswerFields(kind, entity, option, ctx)
  if (fields === null) throw new ApplyError('invalid', `"${option}" names no date`)
  patchEntity(db, kind, ownerId, entity.id, fields, now)
  updateSuggestionRow(db, s, { payload: { ...s.payload, ...fields }, applied_at: now }, now)
}

function answerNewTracker(db: Db, ownerId: string, s: SuggestionRow, option: string, now: number) {
  if (s.target_kind !== 'tracker') throw new ApplyError('invalid', 'not a tracker suggestion')
  const yes = yesNoAnswer(option)
  if (yes === null) throw new ApplyError('invalid', `"${option}" is neither yes nor no`)
  const applied = s.status === 'accepted' || s.status === 'edited'
  if (yes) {
    if (s.status === 'rejected') throw new ApplyError('conflict', 'the tracker was dismissed')
    if (!applied) applySuggestion(db, s, now)
  } else {
    if (applied) throw new ApplyError('conflict', 'the tracker was already created')
    rejectSuggestion(db, s, now)
  }
  refreshReviewStatus(db, ownerId, s.source_bullet_id, now)
}

export { settleTrackerQuestions }

export function answerQuestionWithOption(
  db: Db,
  ownerId: string,
  questionId: string,
  option: string,
  now: number,
): 'applied' | 'duplicate' {
  const q = getQuestion(db, ownerId, questionId)
  if (q.kind === 'reflective') {
    throw new ApplyError('invalid', 'a reflective question is answered with a capture')
  }
  if (q.state !== 'active') throw new ApplyError('invalid', 'question was withdrawn')
  if (q.status === 'answered') {
    if (q.answer_option === option) return 'duplicate'
    throw new ApplyError('invalid', 'question was already answered')
  }
  if (q.status === 'dismissed') throw new ApplyError('invalid', 'question was dismissed')
  if (!q.options.includes(option)) throw new ApplyError('invalid', `"${option}" is not an option`)

  if (q.topic === 'date') {
    answerDate(db, ownerId, linkedSuggestion(db, ownerId, q.suggestion_id), option, now)
  } else if (q.topic === 'new_tracker') {
    answerNewTracker(db, ownerId, linkedSuggestion(db, ownerId, q.suggestion_id), option, now)
  }
  db.update(questions)
    .set({ status: 'answered', answer_option: option, resolved_at: now, updated_at: now })
    .where(eq(questions.id, q.id))
    .run()
  touch(db, ownerId, 'questions', q.id)
  return 'applied'
}
