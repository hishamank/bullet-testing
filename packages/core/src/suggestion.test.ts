import { expect, test } from 'vitest'
import {
  DEFINITION_TARGET_KINDS,
  suggestionInsertSchema,
  suggestionSelectSchema,
} from './suggestion'

const TRACKER_TARGET_ID = '44444444-4444-4444-8444-444444444444'

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

// --- §4.3 operation ↔ target_id coherence -----------------------------------

test('suggestion: ACCEPTS create with target_id null', () => {
  expect(
    suggestionSelectSchema.safeParse({
      ...validSuggestion,
      operation: 'create',
      target_id: null,
    }).success,
  ).toBe(true)
})

test('suggestion: ACCEPTS append with a non-null target_id', () => {
  expect(
    suggestionSelectSchema.safeParse({
      ...validSuggestion,
      operation: 'append',
      target_id: TRACKER_TARGET_ID,
    }).success,
  ).toBe(true)
})

test('suggestion: ACCEPTS update with a non-null target_id', () => {
  expect(
    suggestionSelectSchema.safeParse({
      ...validSuggestion,
      operation: 'update',
      target_id: TRACKER_TARGET_ID,
    }).success,
  ).toBe(true)
})

test('suggestion: REJECTS create with a non-null target_id', () => {
  const res = suggestionSelectSchema.safeParse({
    ...validSuggestion,
    operation: 'create',
    target_id: TRACKER_TARGET_ID,
  })
  expect(res.success).toBe(false)
  if (!res.success) {
    expect(res.error.issues.some((i) => i.path.join('.') === 'target_id')).toBe(true)
  }
})

test('suggestion: REJECTS append with target_id null', () => {
  const res = suggestionSelectSchema.safeParse({
    ...validSuggestion,
    operation: 'append',
    target_id: null,
  })
  expect(res.success).toBe(false)
  if (!res.success) {
    expect(res.error.issues.some((i) => i.path.join('.') === 'target_id')).toBe(true)
  }
})

test('suggestion: REJECTS update with target_id null', () => {
  const res = suggestionSelectSchema.safeParse({
    ...validSuggestion,
    operation: 'update',
    target_id: null,
  })
  expect(res.success).toBe(false)
  if (!res.success) {
    expect(res.error.issues.some((i) => i.path.join('.') === 'target_id')).toBe(true)
  }
})

// The operation↔target_id invariant also holds on the INSERT schema.
test('suggestion insert: REJECTS append with target_id null', () => {
  const res = suggestionInsertSchema.safeParse({
    owner_id: validSuggestion.owner_id,
    source_bullet_id: validSuggestion.source_bullet_id,
    target_kind: 'tracker_entry',
    operation: 'append',
    target_id: null,
    payload: { value: 4 },
    confidence: 0.9,
    tier: 'auto',
    resolved_at: null,
  })
  expect(res.success).toBe(false)
})

// --- §4.5 definitions are never `auto` --------------------------------------

test('DEFINITION_TARGET_KINDS contains tracker (the only v1 definition kind)', () => {
  expect(DEFINITION_TARGET_KINDS).toContain('tracker')
})

test('suggestion: ACCEPTS tracker with tier suggest', () => {
  expect(
    suggestionSelectSchema.safeParse({
      ...validSuggestion,
      target_kind: 'tracker',
      operation: 'create',
      target_id: null,
      tier: 'suggest',
    }).success,
  ).toBe(true)
})

test('suggestion: REJECTS tracker create with tier auto (definitions are never auto)', () => {
  const res = suggestionSelectSchema.safeParse({
    ...validSuggestion,
    target_kind: 'tracker',
    operation: 'create',
    target_id: null,
    tier: 'auto',
  })
  expect(res.success).toBe(false)
  if (!res.success) {
    expect(res.error.issues.some((i) => i.path.join('.') === 'tier')).toBe(true)
  }
})

test('suggestion: ACCEPTS activity with tier auto (records may auto)', () => {
  expect(
    suggestionSelectSchema.safeParse({
      ...validSuggestion,
      target_kind: 'activity',
      operation: 'create',
      target_id: null,
      tier: 'auto',
    }).success,
  ).toBe(true)
})

test('suggestion: ACCEPTS tracker_entry with tier auto (records may auto)', () => {
  expect(
    suggestionSelectSchema.safeParse({
      ...validSuggestion,
      target_kind: 'tracker_entry',
      operation: 'append',
      target_id: TRACKER_TARGET_ID,
      tier: 'auto',
    }).success,
  ).toBe(true)
})

test('suggestion: ACCEPTS task with tier auto', () => {
  expect(
    suggestionSelectSchema.safeParse({
      ...validSuggestion,
      target_kind: 'task',
      operation: 'create',
      target_id: null,
      tier: 'auto',
    }).success,
  ).toBe(true)
})
