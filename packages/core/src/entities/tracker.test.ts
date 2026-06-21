import { expect, test } from 'vitest'
import {
  scaleConfigSchema,
  singleSelectConfigSchema,
  trackerConfigSchema,
  trackerInsertSchema,
  trackerSelectSchema,
} from './tracker'

const base = {
  id: '11111111-1111-4111-8111-111111111111',
  owner_id: '22222222-2222-4222-8222-222222222222',
  source_bullet_id: null,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
  state: 'active' as const,
}

const validScaleTracker = {
  ...base,
  name: 'Mood',
  input_type: 'scale' as const,
  config: { input_type: 'scale' as const, min: 1, max: 5, labels: ['bad', 'great'] },
}

test('tracker select: valid scale tracker parses', () => {
  expect(trackerSelectSchema.parse(validScaleTracker)).toEqual(validScaleTracker)
})

test('tracker select: valid single_select tracker parses', () => {
  const t = {
    ...base,
    name: 'Energy',
    input_type: 'single_select' as const,
    config: { input_type: 'single_select' as const, options: ['low', 'med', 'high'] },
  }
  expect(trackerSelectSchema.parse(t)).toEqual(t)
})

test('tracker select: boolean and text take empty config', () => {
  const boolTracker = {
    ...base,
    name: 'Meditated',
    input_type: 'boolean' as const,
    config: { input_type: 'boolean' as const },
  }
  const textTracker = {
    ...base,
    name: 'Journal note',
    input_type: 'text' as const,
    config: { input_type: 'text' as const },
  }
  expect(trackerSelectSchema.safeParse(boolTracker).success).toBe(true)
  expect(trackerSelectSchema.safeParse(textTracker).success).toBe(true)
})

test('tracker select: rejects bad input_type enum value', () => {
  expect(
    trackerSelectSchema.safeParse({
      ...validScaleTracker,
      input_type: 'rating',
      config: { input_type: 'rating', min: 1, max: 5 },
    }).success,
  ).toBe(false)
})

test('tracker select: rejects empty name', () => {
  expect(trackerSelectSchema.safeParse({ ...validScaleTracker, name: '' }).success).toBe(false)
})

test('tracker config: rejects scale with min >= max', () => {
  expect(trackerConfigSchema.safeParse({ input_type: 'scale', min: 5, max: 5 }).success).toBe(false)
  expect(trackerConfigSchema.safeParse({ input_type: 'scale', min: 7, max: 2 }).success).toBe(false)
})

test('tracker config: rejects select with empty options', () => {
  expect(trackerConfigSchema.safeParse({ input_type: 'single_select', options: [] }).success).toBe(
    false,
  )
  expect(trackerConfigSchema.safeParse({ input_type: 'multi_select', options: [] }).success).toBe(
    false,
  )
})

test('tracker config: rejects select with an empty-string option', () => {
  expect(
    trackerConfigSchema.safeParse({ input_type: 'single_select', options: ['ok', ''] }).success,
  ).toBe(false)
})

test('tracker config: number rejects min > max but allows missing bounds', () => {
  expect(trackerConfigSchema.safeParse({ input_type: 'number' }).success).toBe(true)
  expect(
    trackerConfigSchema.safeParse({ input_type: 'number', unit: 'kg', min: 0, max: 200 }).success,
  ).toBe(true)
  expect(trackerConfigSchema.safeParse({ input_type: 'number', min: 10, max: 1 }).success).toBe(
    false,
  )
})

test('tracker select: rejects when top-level input_type mismatches config discriminant', () => {
  const mismatched = {
    ...base,
    name: 'Mood',
    input_type: 'number' as const,
    config: { input_type: 'scale' as const, min: 1, max: 5 },
  }
  expect(trackerSelectSchema.safeParse(mismatched).success).toBe(false)
})

test('tracker insert: allows omitting id/created_at/updated_at/state', () => {
  const res = trackerInsertSchema.safeParse({
    owner_id: base.owner_id,
    source_bullet_id: null,
    name: 'Mood',
    input_type: 'scale',
    config: { input_type: 'scale', min: 1, max: 5 },
  })
  expect(res.success).toBe(true)
})

// --- standalone config schemas (built from the same shared shapes as the union) ---

test('standalone scaleConfigSchema: accepts min < max, rejects min >= max', () => {
  expect(scaleConfigSchema.safeParse({ input_type: 'scale', min: 1, max: 5 }).success).toBe(true)
  expect(scaleConfigSchema.safeParse({ input_type: 'scale', min: 5, max: 5 }).success).toBe(false)
  expect(scaleConfigSchema.safeParse({ input_type: 'scale', min: 7, max: 2 }).success).toBe(false)
})

test('standalone singleSelectConfigSchema: rejects empty options, accepts a non-empty list', () => {
  expect(
    singleSelectConfigSchema.safeParse({ input_type: 'single_select', options: [] }).success,
  ).toBe(false)
  expect(
    singleSelectConfigSchema.safeParse({ input_type: 'single_select', options: ['low', 'high'] })
      .success,
  ).toBe(true)
})
