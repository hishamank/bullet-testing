import { z } from 'zod'
import { ownedTimestampedStateFields } from '../base'
import { nonEmptyString, uuid } from '../primitives'

/**
 * Question — the engine asking the user something. Slice 1 has CLARIFYING questions only: short,
 * concrete, about an ambiguous extraction ("Which Thursday?", "Start tracking sleep?"). They are
 * optional: ignoring one changes nothing, and the related suggestion stays reviewable as is.
 * Reflective, open-ended questions are slice 2 (and will be optional and never nagging).
 *
 * At most {@link MAX_QUESTIONS_PER_CAPTURE} per capture. Answering is itself a capture: a bullet
 * whose `answers_question_id` points here (the question then becomes `answered`).
 */
export const MAX_QUESTIONS_PER_CAPTURE = 3

export const questionKindSchema = z.enum(['clarifying'])
export type QuestionKind = z.infer<typeof questionKindSchema>

/**
 * What the clarification is about:
 *  - date        — a date/time is ambiguous or could not be understood.
 *  - new_tracker — a reading with no tracker to log it under ("Start tracking X?").
 *  - other       — anything else.
 */
export const questionTopicSchema = z.enum(['date', 'new_tracker', 'other'])
export type QuestionTopic = z.infer<typeof questionTopicSchema>

export const questionStatusSchema = z.enum(['open', 'answered', 'dismissed'])
export type QuestionStatus = z.infer<typeof questionStatusSchema>

export const questionSelectSchema = z.object({
  ...ownedTimestampedStateFields,
  source_bullet_id: uuid(),
  source_thought_id: uuid().nullable(),
  /** The suggestion the question is about, if any. */
  suggestion_id: uuid().nullable(),
  kind: questionKindSchema,
  topic: questionTopicSchema,
  /** The question, ready to show ("Which Thursday — today or next week?"). */
  text: nonEmptyString(),
  /** Quick answers to offer as buttons; empty for free text. */
  options: z.array(nonEmptyString()).max(4),
  status: questionStatusSchema,
  /** The capture that answered it. */
  answer_bullet_id: uuid().nullable(),
  resolved_at: z.number().int().nonnegative().nullable(),
})
export type Question = z.infer<typeof questionSelectSchema>
