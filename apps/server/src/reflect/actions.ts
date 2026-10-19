/**
 * The user's actions on reflective questions that are not answers: "Later" (`question.snooze`)
 * and picking an evergreen question (`question.pick_evergreen`). "Not this one" is
 * `question.dismiss` (capture/thoughts.ts); "Journal about it" is a capture with
 * `answers_question_id`.
 */

import { evergreenQuestion, REFLECTIVE_CAPS } from '@bullet/core'
import { mayPickEvergreen } from '@bullet/engine'
import { eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { questions } from '../db/schema'
import { ApplyError } from '../apply/apply'
import { getQuestion } from '../capture/thoughts'
import { touch } from '../sync/changes'
import { createReflectiveQuestion, reflectiveState } from './questions'

/**
 * "Later": hide the question for a week. Allowed once; a second "Later" dismisses it quietly
 * (`snooze_count` 2, which — unlike "Not this one" — marks nothing as never-ask).
 */
export function snoozeQuestion(db: Db, ownerId: string, id: string, now: number): void {
  const q = getQuestion(db, ownerId, id)
  if (q.kind !== 'reflective') throw new ApplyError('invalid', 'only a reflective question waits')
  if (q.state !== 'active') throw new ApplyError('invalid', 'question was withdrawn')
  if (q.status !== 'open' && q.status !== 'snoozed') return
  const again = q.snooze_count >= 1
  db.update(questions)
    .set(
      again
        ? { status: 'dismissed', snooze_count: 2, resolved_at: now, updated_at: now }
        : {
            status: 'snoozed',
            snooze_count: 1,
            snoozed_until: now + REFLECTIVE_CAPS.snoozeMs,
            updated_at: now,
          },
    )
    .where(eq(questions.id, q.id))
    .run()
  touch(db, ownerId, 'questions', q.id)
}

/**
 * The user picked an evergreen question to journal about: create it with the phone's id. It may
 * go one over the open cap; the daily cap and the pauses don't apply (the user asked).
 */
export function pickEvergreen(
  db: Db,
  ownerId: string,
  questionId: string,
  templateId: string,
  now: number,
): 'applied' | 'duplicate' {
  const template = evergreenQuestion(templateId)
  if (!template) throw new ApplyError('invalid', `unknown evergreen question ${templateId}`)
  const existing = db.select().from(questions).where(eq(questions.id, questionId)).get()
  if (existing) {
    if (existing.owner_id === ownerId && existing.template_id === templateId) return 'duplicate'
    throw new ApplyError('invalid', `question id ${questionId} is already used`)
  }
  if (!mayPickEvergreen(reflectiveState(db, ownerId, now).open)) {
    throw new ApplyError('conflict', 'enough questions are open already')
  }
  createReflectiveQuestion(
    db,
    {
      id: questionId,
      ownerId,
      origin: 'evergreen',
      text: template.text,
      sourceBulletId: null,
      sourceThoughtId: null,
      templateId,
    },
    now,
  )
  return 'applied'
}
