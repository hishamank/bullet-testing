import { expect, test } from 'vitest'
import {
  trackerEntryInsertSchema,
  trackerEntrySelectSchema,
  trackerEntryValueSchema,
} from './trackerEntry'

const validEntry = {
  id: '11111111-1111-4111-8111-111111111111',
  owner_id: '22222222-2222-4222-8222-222222222222',
  source_bullet_id: null,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
  state: 'active' as const,
  tracker_id: '33333333-3333-4333-8333-333333333333',
  value: 4,
  logged_at: 1_700_000_000_000,
}

test('tracker entry select: valid numeric value parses', () => {
  expect(trackerEntrySelectSchema.parse(validEntry)).toEqual(validEntry)
})

test('tracker entry select: accepts string, boolean and string[] values', () => {
  expect(trackerEntrySelectSchema.safeParse({ ...validEntry, value: 'note' }).success).toBe(true)
  expect(trackerEntrySelectSchema.safeParse({ ...validEntry, value: true }).success).toBe(true)
  expect(trackerEntrySelectSchema.safeParse({ ...validEntry, value: ['a', 'b'] }).success).toBe(
    true,
  )
})

test('tracker entry select: rejects wrong value type (object)', () => {
  expect(trackerEntrySelectSchema.safeParse({ ...validEntry, value: { x: 1 } }).success).toBe(false)
})

test('tracker entry select: rejects array of non-strings', () => {
  expect(trackerEntrySelectSchema.safeParse({ ...validEntry, value: [1, 2] }).success).toBe(false)
})

test('tracker entry select: rejects non-uuid tracker_id', () => {
  expect(trackerEntrySelectSchema.safeParse({ ...validEntry, tracker_id: 'x' }).success).toBe(false)
})

test('tracker entry select: rejects missing required field (logged_at)', () => {
  const { logged_at, ...rest } = validEntry
  void logged_at
  expect(trackerEntrySelectSchema.safeParse(rest).success).toBe(false)
})

test('tracker entry select: rejects non-integer logged_at', () => {
  expect(trackerEntrySelectSchema.safeParse({ ...validEntry, logged_at: 1.1 }).success).toBe(false)
})

test('tracker entry insert: allows omitting id/created_at/updated_at/state', () => {
  const res = trackerEntryInsertSchema.safeParse({
    owner_id: validEntry.owner_id,
    source_bullet_id: null,
    tracker_id: validEntry.tracker_id,
    value: 3,
    logged_at: 1_700_000_000_000,
  })
  expect(res.success).toBe(true)
})

// --- direct coverage of the value union ------------------------------------

test('trackerEntryValueSchema: accepts number, string, boolean and string[]', () => {
  expect(trackerEntryValueSchema.safeParse(4).success).toBe(true)
  expect(trackerEntryValueSchema.safeParse('note').success).toBe(true)
  expect(trackerEntryValueSchema.safeParse(true).success).toBe(true)
  expect(trackerEntryValueSchema.safeParse(['a', 'b']).success).toBe(true)
})

test('trackerEntryValueSchema: rejects number[] and object/mixed values', () => {
  expect(trackerEntryValueSchema.safeParse([1, 2]).success).toBe(false)
  expect(trackerEntryValueSchema.safeParse(['a', 1]).success).toBe(false)
  expect(trackerEntryValueSchema.safeParse({ x: 1 }).success).toBe(false)
  expect(trackerEntryValueSchema.safeParse(null).success).toBe(false)
})
