import { expect, test } from 'vitest'
import { suggestionInsertSchema, suggestionSelectSchema } from './suggestion'

const validSuggestion = {
  id: '11111111-1111-4111-8111-111111111111',
  owner_id: '22222222-2222-4222-8222-222222222222',
  source_bullet_id: '33333333-3333-4333-8333-333333333333',
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
  state: 'active' as const,
  target_kind: 'task' as const,
  operation: 'create' as const,
  target_id: null,
  payload: { title: 'Call the dentist' },
  confidence: 0.92,
  tier: 'suggest' as const,
  status: 'pending' as const,
  resolved_at: null,
}

test('suggestion select: valid object parses', () => {
  expect(suggestionSelectSchema.parse(validSuggestion)).toEqual(validSuggestion)
})

test('suggestion select: confidence accepts the inclusive bounds 0 and 1', () => {
  expect(suggestionSelectSchema.safeParse({ ...validSuggestion, confidence: 0 }).success).toBe(true)
  expect(suggestionSelectSchema.safeParse({ ...validSuggestion, confidence: 1 }).success).toBe(true)
})

test('suggestion select: rejects confidence outside 0..1', () => {
  expect(suggestionSelectSchema.safeParse({ ...validSuggestion, confidence: -0.01 }).success).toBe(
    false,
  )
  expect(suggestionSelectSchema.safeParse({ ...validSuggestion, confidence: 1.01 }).success).toBe(
    false,
  )
})

test('suggestion select: rejects bad enum values', () => {
  expect(suggestionSelectSchema.safeParse({ ...validSuggestion, tier: 'maybe' }).success).toBe(
    false,
  )
  expect(suggestionSelectSchema.safeParse({ ...validSuggestion, status: 'open' }).success).toBe(
    false,
  )
  expect(
    suggestionSelectSchema.safeParse({ ...validSuggestion, target_kind: 'note' }).success,
  ).toBe(false)
  expect(
    suggestionSelectSchema.safeParse({ ...validSuggestion, operation: 'delete' }).success,
  ).toBe(false)
})

test('suggestion select: source_bullet_id is required (non-null) — null is rejected', () => {
  expect(
    suggestionSelectSchema.safeParse({ ...validSuggestion, source_bullet_id: null }).success,
  ).toBe(false)
})

test('suggestion select: rejects missing required field (payload)', () => {
  const { payload, ...rest } = validSuggestion
  void payload
  expect(suggestionSelectSchema.safeParse(rest).success).toBe(false)
})

test('suggestion select: rejects non-integer resolved_at', () => {
  expect(suggestionSelectSchema.safeParse({ ...validSuggestion, resolved_at: 1.5 }).success).toBe(
    false,
  )
})

test('suggestion insert: allows omitting id/created_at/updated_at/state and defaults status to pending', () => {
  const res = suggestionInsertSchema.safeParse({
    owner_id: validSuggestion.owner_id,
    source_bullet_id: validSuggestion.source_bullet_id,
    target_kind: 'task',
    operation: 'create',
    target_id: null,
    payload: { title: 'x' },
    confidence: 0.5,
    tier: 'ask',
    resolved_at: null,
  })
  expect(res.success).toBe(true)
  if (res.success) {
    expect(res.data.status).toBe('pending')
  }
})
