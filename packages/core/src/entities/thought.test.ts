import { expect, test } from 'vite-plus/test'
import {
  CONNECTION_OPTIONS,
  connectionQuestionText,
  EVERGREEN_QUESTIONS,
  evergreenQuestion,
  isReflectiveShowing,
  MAX_QUESTIONS_PER_CAPTURE,
  questionSelectSchema,
  staleLoopQuestionText,
} from './question'
import { thoughtKindSchema, thoughtSelectSchema } from './thought'

const base = {
  id: '11111111-1111-4111-8111-111111111111',
  owner_id: '22222222-2222-4222-8222-222222222222',
  source_bullet_id: '33333333-3333-4333-8333-333333333333',
  created_at: 1,
  updated_at: 1,
  state: 'active' as const,
}

test('thought kinds are the slice-1 set', () => {
  expect(thoughtKindSchema.options).toEqual([
    'worry',
    'to_check',
    'question',
    'idea',
    'note',
    'task',
    'event',
    'tracker',
    'activity',
  ])
})

test('thought: valid parses; span optional; bad span rejected', () => {
  const t = {
    ...base,
    position: 0,
    text: 'worried about the landlord',
    span: { start: 0, end: 26 },
    kind: 'worry' as const,
    kind_source: 'engine' as const,
    resolved_at: null,
    resolved_by_bullet_id: null,
    sensitive: false,
    never_ask: false,
  }
  expect(thoughtSelectSchema.parse(t)).toEqual(t)
  // Rows from before open loops / reflective questions existed are still valid.
  const { resolved_at, resolved_by_bullet_id, sensitive, never_ask, ...older } = t
  void resolved_at
  void resolved_by_bullet_id
  void sensitive
  void never_ask
  expect(thoughtSelectSchema.parse(older)).toEqual(t)
  expect(thoughtSelectSchema.safeParse({ ...t, span: null }).success).toBe(true)
  expect(thoughtSelectSchema.safeParse({ ...t, span: { start: 5, end: 2 } }).success).toBe(false)
  expect(thoughtSelectSchema.safeParse({ ...t, kind: 'rant' }).success).toBe(false)
})

test('question: clarifying with up to 4 quick options; older rows read as clarifying', () => {
  const q = {
    ...base,
    source_thought_id: null,
    suggestion_id: null,
    kind: 'clarifying' as const,
    origin: 'capture' as const,
    topic: 'date' as const,
    text: 'Which Thursday?',
    options: ['Today', 'Next week'],
    status: 'open' as const,
    answer_bullet_id: null,
    answer_option: null,
    resolved_at: null,
    snoozed_until: null,
    snooze_count: 0,
    template_id: null,
    related_thought_id: null,
  }
  expect(questionSelectSchema.parse(q)).toEqual(q)
  const { kind, origin, snoozed_until, snooze_count, template_id, related_thought_id, ...older } = q
  void [kind, origin, snoozed_until, snooze_count, template_id, related_thought_id]
  expect(questionSelectSchema.parse(older)).toEqual(q)
  expect(questionSelectSchema.safeParse({ ...q, kind: 'rhetorical' }).success).toBe(false)
  expect(questionSelectSchema.safeParse({ ...q, options: ['a', 'b', 'c', 'd', 'e'] }).success).toBe(
    false,
  )
  expect(MAX_QUESTIONS_PER_CAPTURE).toBeLessThanOrEqual(3)
})

test('question: reflective, snoozed, evergreen without a source capture', () => {
  const q = questionSelectSchema.parse({
    ...base,
    source_bullet_id: null,
    source_thought_id: null,
    suggestion_id: null,
    kind: 'reflective',
    origin: 'evergreen',
    topic: 'other',
    text: 'What surprised you this week?',
    options: [],
    status: 'snoozed',
    answer_bullet_id: null,
    resolved_at: null,
    snoozed_until: 100,
    snooze_count: 1,
    template_id: 'surprised',
  })
  expect(isReflectiveShowing(q, 99)).toBe(false)
  expect(isReflectiveShowing(q, 100)).toBe(true)
  expect(isReflectiveShowing({ ...q, status: 'open' }, 0)).toBe(true)
  expect(isReflectiveShowing({ ...q, kind: 'clarifying', status: 'open' }, 0)).toBe(false)
  expect(isReflectiveShowing({ ...q, status: 'dismissed' }, 200)).toBe(false)
})

test('question: a connection question offers Same thing / Different about two thoughts', () => {
  const q = questionSelectSchema.parse({
    ...base,
    source_thought_id: base.id,
    suggestion_id: null,
    kind: 'reflective',
    origin: 'connection',
    topic: 'other',
    text: connectionQuestionText('should I switch banks', 'moving my account'),
    options: [...CONNECTION_OPTIONS],
    status: 'open',
    answer_bullet_id: null,
    resolved_at: null,
    related_thought_id: base.id,
  })
  expect(q.text).toBe('Is this the same thing? «should I switch banks» / «moving my account»')
  expect(q.options).toEqual(['Same thing', 'Different'])
  expect(connectionQuestionText('ma ba3ref', 'shu ba3mel', 'arabizi')).toMatch(
    /^Hayda nafs l shi\?/,
  )
})

test('evergreen questions: about 20, unique ids, calm questions', () => {
  expect(EVERGREEN_QUESTIONS.length).toBeGreaterThanOrEqual(18)
  expect(new Set(EVERGREEN_QUESTIONS.map((q) => q.id)).size).toBe(EVERGREEN_QUESTIONS.length)
  for (const q of EVERGREEN_QUESTIONS) {
    expect(q.text.endsWith('?'), q.id).toBe(true)
    expect(q.text, q.id).not.toMatch(
      /\b(you should|you must|need to|try to|therapy|disorder|symptom)\b/i,
    )
  }
  expect(evergreenQuestion('surprised')?.text).toBe('What surprised you this week?')
  expect(evergreenQuestion('nope')).toBeUndefined()
  expect(staleLoopQuestionText(' check the passport ')).toBe(
    'Still on your mind? «check the passport»',
  )
  expect(staleLoopQuestionText('vérifier le passeport', 'fr')).toBe(
    'Toujours en tête\u202F? «vérifier le passeport»',
  )
  expect(staleLoopQuestionText('shuf l passport', 'arabizi')).toBe(
    'Ba3do 3a balak? «shuf l passport»',
  )
  // Arabic: the Arabic question mark is kept, and the text starts with an Arabic letter so it
  // lays out right to left, the quoted thought after (to the left of) the prefix.
  const ar = staleLoopQuestionText('شوف إذا الباسبور بعدو صالح', 'ar')
  expect(ar).toBe('بعدو عبالك؟ «شوف إذا الباسبور بعدو صالح»')
  expect(ar).not.toContain('?')
  expect(ar.charCodeAt(0)).toBeGreaterThanOrEqual(0x0600)
  expect(ar.charCodeAt(0)).toBeLessThanOrEqual(0x06ff)
})
