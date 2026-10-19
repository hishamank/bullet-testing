import { z } from 'zod'
import { ownedTimestampedStateFields } from '../base'
import { nonEmptyString, timestampMs, uuid } from '../primitives'

/**
 * Question — the app asking the user something. Two kinds:
 *
 *  - CLARIFYING (slice 1): short, concrete, about an ambiguous extraction ("Which Thursday?",
 *    "Start tracking sleep?"). Optional: ignoring one changes nothing, and the related suggestion
 *    stays reviewable as is. At most {@link MAX_QUESTIONS_PER_CAPTURE} per capture. Answered with
 *    a capture (`answers_question_id`) or by tapping one of its `options` (`question.answer`).
 *  - REFLECTIVE (slice 2): an open question to think about, never a to-do. Asked about what the
 *    user said, never what they should do. Never counted in the Inbox badge, never notified.
 *    Answered only with a capture ("Journal about it"), possibly several. They come from three
 *    {@link QuestionOrigin}s and are rate-limited across all of them ({@link REFLECTIVE_CAPS}).
 *
 * Either way an answering capture makes the question `answered`.
 */
export const MAX_QUESTIONS_PER_CAPTURE = 3

export const questionKindSchema = z.enum(['clarifying', 'reflective'])
export type QuestionKind = z.infer<typeof questionKindSchema>

/**
 * Where a question came from:
 *  - capture   — a capture's own words (every clarifying question; a reflective one about a
 *                worry, self-question or idea in it).
 *  - open_loop — a `to_check` / `question` thought left unresolved for a week ("Still on your
 *                mind?"). Reflective only.
 *  - evergreen — one of the hand-written {@link EVERGREEN_QUESTIONS} (`template_id`), offered now
 *                and then or picked by the user. Reflective only; it has no source capture.
 */
export const questionOriginSchema = z.enum(['capture', 'open_loop', 'evergreen'])
export type QuestionOrigin = z.infer<typeof questionOriginSchema>

/**
 * What the clarification is about:
 *  - date        — a date/time is ambiguous or could not be understood.
 *  - new_tracker — a reading with no tracker to log it under ("Start tracking X?").
 *  - other       — anything else. Reflective questions are always `other`.
 */
export const questionTopicSchema = z.enum(['date', 'new_tracker', 'other'])
export type QuestionTopic = z.infer<typeof questionTopicSchema>

/**
 * `snoozed` (reflective only): "Later". Hidden until `snoozed_until`, then open again. Snoozing is
 * allowed once; a second "Later" dismisses the question quietly.
 */
export const questionStatusSchema = z.enum(['open', 'answered', 'dismissed', 'snoozed'])
export type QuestionStatus = z.infer<typeof questionStatusSchema>

export const questionSelectSchema = z.object({
  ...ownedTimestampedStateFields,
  /** The capture the question is about. Null only for `evergreen` questions. */
  source_bullet_id: uuid().nullable(),
  source_thought_id: uuid().nullable(),
  /** The suggestion the question is about, if any (clarifying only). */
  suggestion_id: uuid().nullable(),
  kind: questionKindSchema.default('clarifying'),
  origin: questionOriginSchema.default('capture'),
  topic: questionTopicSchema,
  /** The question, ready to show ("Which Thursday — today or next week?"). */
  text: nonEmptyString(),
  /** Quick answers to offer as buttons; empty for free text (always empty when reflective). */
  options: z.array(nonEmptyString()).max(4),
  status: questionStatusSchema,
  /** The capture that answered it first (a typed or spoken answer). */
  answer_bullet_id: uuid().nullable(),
  /** The option the user tapped (`question.answer`), if answered that way. */
  answer_option: nonEmptyString().nullable().default(null),
  resolved_at: z.number().int().nonnegative().nullable(),
  /** While `snoozed`: when it shows again. */
  snoozed_until: timestampMs().nullable().default(null),
  /** How many times "Later" was used (at most once; the second dismisses). */
  snooze_count: z.number().int().nonnegative().default(0),
  /** `evergreen` questions: which {@link EVERGREEN_QUESTIONS} entry it is. */
  template_id: nonEmptyString().nullable().default(null),
})
export type Question = z.infer<typeof questionSelectSchema>

// --- reflective questions (slice 2) ---

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The limits on reflective questions, enforced by the server across all three origins.
 *  - maxOpen         — open (or snoozed) at once; generation pauses at this many. A question the
 *                      user picks from the evergreen list may go one over.
 *  - maxNewPerDay    — new ones in any rolling 24 hours.
 *  - quietAfterMs    — nothing new while the user hasn't captured anything for this long.
 *  - snoozeMs        — how long "Later" hides one.
 *  - staleLoopMs     — an open loop unresolved this long gets "Still on your mind?".
 *  - evergreenEveryMs — at most one evergreen question per this long.
 *  - sensitivePauseMs — evergreen questions pause this long after a sensitive thought.
 */
export const REFLECTIVE_CAPS = {
  maxOpen: 3,
  maxNewPerDay: 2,
  quietAfterMs: 14 * DAY_MS,
  snoozeMs: 7 * DAY_MS,
  staleLoopMs: 7 * DAY_MS,
  evergreenEveryMs: 3 * DAY_MS,
  sensitivePauseMs: 7 * DAY_MS,
} as const

/** The thought kinds a capture's reflective question may be about. */
export const REFLECTIVE_THOUGHT_KINDS = ['worry', 'question', 'idea'] as const

/** The languages a templated reflective question can be worded in (the quote's language). */
export type ReflectiveLanguage = 'en' | 'fr' | 'arabizi' | 'ar'

/** "Still on your mind?" in the language of the thought it quotes. */
export const STALE_LOOP_PREFIX: Record<ReflectiveLanguage, string> = {
  en: 'Still on your mind?',
  fr: 'Toujours en tête ?',
  arabizi: 'Ba3do 3a balak?',
  ar: 'بعدو عبالك؟',
}

/**
 * The question asked about a stale open loop (template, no model), its prefix in the thought's
 * language (the server guesses it with `quoteLanguage` from `@bullet/engine`).
 */
export function staleLoopQuestionText(
  thoughtText: string,
  language: ReflectiveLanguage = 'en',
): string {
  return `${STALE_LOOP_PREFIX[language]} «${thoughtText.trim()}»`
}

/** Is a reflective question showing in "To think about" at `now` (open, or its snooze is over)? */
export function isReflectiveShowing(
  q: Pick<Question, 'kind' | 'state' | 'status' | 'snoozed_until'>,
  now: number,
): boolean {
  if (q.kind !== 'reflective' || q.state !== 'active') return false
  if (q.status === 'open') return true
  return q.status === 'snoozed' && (q.snoozed_until ?? 0) <= now
}

export interface EvergreenQuestion {
  /** Stable id (`template_id`); never reused for different words. */
  id: string
  text: string
}

/**
 * Hand-written questions to think about, offered when nothing else is open (or picked by the
 * user). Calm, open, about the user's own experience; never advice, never clinical.
 */
export const EVERGREEN_QUESTIONS: readonly EvergreenQuestion[] = [
  { id: 'energy-drain', text: 'What took more energy than it should have this week?' },
  { id: 'small-good', text: 'What small thing went well recently?' },
  { id: 'looking-forward', text: 'What are you looking forward to, even a little?' },
  { id: 'kept-thinking', text: 'What have you kept coming back to in your head lately?' },
  { id: 'felt-like-you', text: 'When did you last feel most like yourself?' },
  { id: 'surprised', text: 'What surprised you this week?' },
  { id: 'unsaid', text: "Is there something you've been meaning to say to someone?" },
  { id: 'enough', text: 'What would make this week feel like enough?' },
  { id: 'gave-energy', text: 'What gave you energy recently?' },
  {
    id: 'putting-off',
    text: 'What have you been putting off, and how does it feel to think about it?',
  },
  { id: 'grateful-person', text: 'Who made your days a bit easier lately?' },
  { id: 'changed-mind', text: 'What did you change your mind about recently?' },
  { id: 'quiet-moment', text: 'When did you last have a quiet moment to yourself?' },
  { id: 'learned', text: 'What did you learn about yourself this month?' },
  { id: 'carrying', text: 'What are you carrying around that you could set down?' },
  { id: 'proud', text: 'What did you do lately that you are quietly proud of?' },
  { id: 'more-of', text: 'What would you like more of in your days?' },
  { id: 'less-of', text: 'What would you like less of in your days?' },
  { id: 'season', text: 'How would you describe this season of your life?' },
  { id: 'enjoyed-time', text: 'Where did time go by without you noticing?' },
]

/** The evergreen question with this `template_id`, if any. */
export function evergreenQuestion(templateId: string): EvergreenQuestion | undefined {
  return EVERGREEN_QUESTIONS.find((q) => q.id === templateId)
}
