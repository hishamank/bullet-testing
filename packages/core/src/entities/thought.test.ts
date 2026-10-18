import { expect, test } from 'vite-plus/test'
import { MAX_QUESTIONS_PER_CAPTURE, questionSelectSchema } from './question'
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
  }
  expect(thoughtSelectSchema.parse(t)).toEqual(t)
  expect(thoughtSelectSchema.safeParse({ ...t, span: null }).success).toBe(true)
  expect(thoughtSelectSchema.safeParse({ ...t, span: { start: 5, end: 2 } }).success).toBe(false)
  expect(thoughtSelectSchema.safeParse({ ...t, kind: 'rant' }).success).toBe(false)
})

test('question: clarifying only in slice 1, up to 4 quick options', () => {
  const q = {
    ...base,
    source_thought_id: null,
    suggestion_id: null,
    kind: 'clarifying' as const,
    topic: 'date' as const,
    text: 'Which Thursday?',
    options: ['Today', 'Next week'],
    status: 'open' as const,
    answer_bullet_id: null,
    resolved_at: null,
  }
  expect(questionSelectSchema.parse(q)).toEqual(q)
  expect(questionSelectSchema.safeParse({ ...q, kind: 'reflective' }).success).toBe(false)
  expect(questionSelectSchema.safeParse({ ...q, options: ['a', 'b', 'c', 'd', 'e'] }).success).toBe(
    false,
  )
  expect(MAX_QUESTIONS_PER_CAPTURE).toBeLessThanOrEqual(3)
})
