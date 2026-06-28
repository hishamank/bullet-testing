import { expect, test } from 'vitest'
import { activityInsertSchema, activitySelectSchema } from './activity'

const validActivity = {
  id: '11111111-1111-4111-8111-111111111111',
  owner_id: '22222222-2222-4222-8222-222222222222',
  source_bullet_id: '33333333-3333-4333-8333-333333333333',
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
  state: 'active' as const,
  name: 'Ran 5k',
  occurred_at: 1_700_000_000_000,
  tracker_id: null,
  notes: null,
  quantity: 5,
  unit: 'km',
}

test('activity select: valid object parses; tracker link may be null', () => {
  expect(activitySelectSchema.parse(validActivity)).toEqual(validActivity)
  expect(activitySelectSchema.parse({ ...validActivity, tracker_id: null }).tracker_id).toBeNull()
})

test('activity select: rejects empty name', () => {
  expect(activitySelectSchema.safeParse({ ...validActivity, name: '' }).success).toBe(false)
})

test('activity select: rejects missing required field (occurred_at)', () => {
  const { occurred_at, ...rest } = validActivity
  void occurred_at
  expect(activitySelectSchema.safeParse(rest).success).toBe(false)
})

test('activity select: rejects negative occurred_at', () => {
  expect(activitySelectSchema.safeParse({ ...validActivity, occurred_at: -1 }).success).toBe(false)
})

test('activity select: rejects bad state enum value', () => {
  expect(activitySelectSchema.safeParse({ ...validActivity, state: 'gone' }).success).toBe(false)
})

test('activity insert: allows omitting id/created_at/updated_at/state', () => {
  const res = activityInsertSchema.safeParse({
    owner_id: validActivity.owner_id,
    source_bullet_id: null,
    name: 'Meditated',
    occurred_at: 1_700_000_000_000,
    tracker_id: null,
    notes: null,
    quantity: null,
    unit: null,
  })
  expect(res.success).toBe(true)
})
