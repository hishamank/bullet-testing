/**
 * `POST /sync/push`: apply the phone's outbox, op by op, in order. Each op runs in its own
 * transaction together with the record of its outcome, so a replay (same op_id) is answered from
 * that record and never does the work twice.
 */

import type { PushOp, PushOpResult } from '@bullet/core'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { syncOps } from '../db/schema'
import {
  ApplyError,
  applySuggestion,
  getSuggestion,
  refreshReviewStatus,
  rejectSuggestion,
  settleTrackerQuestions,
  undoSuggestion,
} from '../apply/apply'
import { answerQuestionWithOption } from '../apply/answer'
import { deleteByHand, editByHand } from '../apply/manual'
import { createBullet, deleteBullet, editBullet, retryBullet } from '../capture/bullets'
import {
  dismissQuestion,
  reclassifyThought,
  resolveThought,
  unresolveThought,
} from '../capture/thoughts'

function suggestionOrThrow(db: Db, ownerId: string, id: string) {
  const s = getSuggestion(db, ownerId, id)
  if (!s) throw new ApplyError('not_found', `suggestion ${id} not found`)
  return s
}

/** Execute one op. Returns `duplicate` for an idempotent no-op, else `applied`; throws to refuse. */
function executeOp(db: Db, ownerId: string, op: PushOp, now: number): 'applied' | 'duplicate' {
  switch (op.type) {
    case 'bullet.create':
      return createBullet(db, ownerId, op.bullet, now)
    case 'bullet.edit':
      editBullet(db, ownerId, op.bullet_id, op.text, op.edited_at, now)
      return 'applied'
    case 'bullet.delete':
      deleteBullet(db, ownerId, op.bullet_id, op.mode, now)
      return 'applied'
    case 'bullet.retry':
      retryBullet(db, ownerId, op.bullet_id, now)
      return 'applied'
    case 'suggestion.accept': {
      const s = suggestionOrThrow(db, ownerId, op.suggestion_id)
      // Already accepted (e.g. from another device): nothing to do.
      if (s.status === 'accepted' || s.status === 'edited') return 'duplicate'
      applySuggestion(db, s, now, { payload: op.payload })
      settleTrackerQuestions(db, s, true, now)
      refreshReviewStatus(db, ownerId, s.source_bullet_id, now)
      return 'applied'
    }
    case 'suggestion.reject': {
      const s = suggestionOrThrow(db, ownerId, op.suggestion_id)
      rejectSuggestion(db, s, now)
      settleTrackerQuestions(db, s, false, now)
      refreshReviewStatus(db, ownerId, s.source_bullet_id, now)
      return 'applied'
    }
    case 'suggestion.undo': {
      const s = suggestionOrThrow(db, ownerId, op.suggestion_id)
      undoSuggestion(db, s, now)
      return 'applied'
    }
    case 'thought.reclassify':
      reclassifyThought(db, ownerId, op.thought_id, op.kind, now)
      return 'applied'
    case 'question.dismiss':
      dismissQuestion(db, ownerId, op.question_id, now)
      return 'applied'
    case 'question.answer':
      return answerQuestionWithOption(db, ownerId, op.question_id, op.option, now)
    case 'thought.resolve':
      resolveThought(db, ownerId, op.thought_id, now)
      return 'applied'
    case 'thought.unresolve':
      unresolveThought(db, ownerId, op.thought_id, now)
      return 'applied'
    case 'task.update':
      editByHand(db, 'task', ownerId, op.task_id, op.patch, now)
      return 'applied'
    case 'task.delete':
      deleteByHand(db, 'task', ownerId, op.task_id, now)
      return 'applied'
    case 'event.update':
      editByHand(db, 'event', ownerId, op.event_id, op.patch, now)
      return 'applied'
    case 'event.delete':
      deleteByHand(db, 'event', ownerId, op.event_id, now)
      return 'applied'
    case 'tracker_entry.update':
      editByHand(db, 'tracker_entry', ownerId, op.tracker_entry_id, op.patch, now)
      return 'applied'
    case 'tracker_entry.delete':
      deleteByHand(db, 'tracker_entry', ownerId, op.tracker_entry_id, now)
      return 'applied'
    default: {
      const never: never = op
      throw new ApplyError('invalid', `unknown op ${String((never as PushOp).type)}`)
    }
  }
}

export interface PushOutcome {
  results: PushOpResult[]
  /** True when at least one op queued work for the processor (capture/edit/retry). */
  queuedWork: boolean
}

export function pushOps(db: Db, ownerId: string, ops: PushOp[], now: () => number): PushOutcome {
  const results: PushOpResult[] = []
  let queuedWork = false
  for (const op of ops) {
    const result = db.transaction((tx): PushOpResult => {
      const seen = tx
        .select()
        .from(syncOps)
        .where(and(eq(syncOps.owner_id, ownerId), eq(syncOps.op_id, op.op_id)))
        .get()
      if (seen) {
        const prior = seen.result as PushOpResult
        return prior.status === 'rejected' ? prior : { op_id: op.op_id, status: 'duplicate' }
      }
      let outcome: PushOpResult
      try {
        // A nested transaction (savepoint): a refused op rolls back its partial writes but the
        // outcome below is still recorded.
        const status = tx.transaction((inner) => executeOp(inner, ownerId, op, now()))
        outcome = { op_id: op.op_id, status }
      } catch (err) {
        if (!(err instanceof ApplyError)) throw err
        outcome = {
          op_id: op.op_id,
          status: 'rejected',
          error: { code: err.code, message: err.message },
        }
      }
      tx.insert(syncOps)
        .values({
          owner_id: ownerId,
          op_id: op.op_id,
          type: op.type,
          result: outcome,
          created_at: now(),
        })
        .run()
      return outcome
    })
    if (
      result.status === 'applied' &&
      (op.type === 'bullet.create' || op.type === 'bullet.edit' || op.type === 'bullet.retry')
    ) {
      queuedWork = true
    }
    results.push(result)
  }
  return { results, queuedWork }
}
