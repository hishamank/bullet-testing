import { expect, test } from 'vite-plus/test'
import { eventInsertSchema, eventSelectSchema } from './event'

const validEvent = {
  id: '11111111-1111-4111-8111-111111111111',
  owner_id: '22222222-2222-4222-8222-222222222222',
  source_bullet_id: '33333333-3333-4333-8333-333333333333',
  source_thought_id: null,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
  state: 'active' as const,
  title: 'Dentist',
  starts_at: 1_700_000_000_000,
  ends_at: 1_700_003_600_000,
  all_day: false,
  location: 'Main St',
  notes: null,
}

test('event select: valid object parses', () => {
  expect(eventSelectSchema.parse(validEvent)).toEqual(validEvent)
})

test('event select: ends_at may be null', () => {
  expect(eventSelectSchema.safeParse({ ...validEvent, ends_at: null }).success).toBe(true)
})

test('event select: rejects ends_at before starts_at', () => {
  const res = eventSelectSchema.safeParse({ ...validEvent, ends_at: validEvent.starts_at - 1 })
  expect(res.success).toBe(false)
  if (!res.success) expect(res.error.issues[0]?.path).toEqual(['ends_at'])
})

test('event select: rejects empty title', () => {
  expect(eventSelectSchema.safeParse({ ...validEvent, title: '' }).success).toBe(false)
})

test('event insert: defaults all_day to false and allows omitting server fields', () => {
  const res = eventInsertSchema.safeParse({
    owner_id: validEvent.owner_id,
    source_bullet_id: null,
    title: 'Dinner',
    starts_at: 1_700_000_000_000,
    ends_at: null,
    location: null,
    notes: null,
  })
  expect(res.success).toBe(true)
  if (res.success) expect(res.data.all_day).toBe(false)
})
