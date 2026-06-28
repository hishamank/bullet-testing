import { expect, test } from 'vitest'
import { taskInsertSchema } from './entities/task'
import { targetKindSchema } from './enums'
import { insertSchemaFor, targetKindInsertSchemas, validateSuggestionPayload } from './registry'

test('registry: has an INSERT schema for every TargetKind', () => {
  for (const kind of targetKindSchema.options) {
    expect(targetKindInsertSchemas[kind]).toBeDefined()
  }
})

test('insertSchemaFor returns the matching schema instance', () => {
  expect(insertSchemaFor('task')).toBe(taskInsertSchema)
})

test('validateSuggestionPayload: accepts a correct task payload', () => {
  const res = validateSuggestionPayload('task', {
    owner_id: '22222222-2222-4222-8222-222222222222',
    source_bullet_id: null,
    title: 'Call the dentist',
    notes: null,
    due_at: null,
    priority: null,
  })
  expect(res.success).toBe(true)
})

test('validateSuggestionPayload: rejects a malformed task payload (empty title)', () => {
  const res = validateSuggestionPayload('task', {
    owner_id: '22222222-2222-4222-8222-222222222222',
    source_bullet_id: null,
    title: '',
    notes: null,
    due_at: null,
    priority: null,
  })
  expect(res.success).toBe(false)
})

test('validateSuggestionPayload: accepts a correct tracker payload', () => {
  const res = validateSuggestionPayload('tracker', {
    owner_id: '22222222-2222-4222-8222-222222222222',
    source_bullet_id: null,
    name: 'Mood',
    input_type: 'scale',
    config: { input_type: 'scale', min: 1, max: 5 },
  })
  expect(res.success).toBe(true)
})

test('validateSuggestionPayload: rejects a malformed tracker payload (scale min >= max)', () => {
  const res = validateSuggestionPayload('tracker', {
    owner_id: '22222222-2222-4222-8222-222222222222',
    source_bullet_id: null,
    name: 'Mood',
    input_type: 'scale',
    config: { input_type: 'scale', min: 5, max: 1 },
  })
  expect(res.success).toBe(false)
})

test('validateSuggestionPayload: accepts a correct tracker_entry payload', () => {
  const res = validateSuggestionPayload('tracker_entry', {
    owner_id: '22222222-2222-4222-8222-222222222222',
    source_bullet_id: null,
    tracker_id: '33333333-3333-4333-8333-333333333333',
    value: 4,
    logged_at: 1_700_000_000_000,
  })
  expect(res.success).toBe(true)
})

test('validateSuggestionPayload: rejects a malformed tracker_entry payload (value is an object)', () => {
  const res = validateSuggestionPayload('tracker_entry', {
    owner_id: '22222222-2222-4222-8222-222222222222',
    source_bullet_id: null,
    tracker_id: '33333333-3333-4333-8333-333333333333',
    value: { not: 'a valid value' },
    logged_at: 1_700_000_000_000,
  })
  expect(res.success).toBe(false)
})

test('validateSuggestionPayload: rejects an activity payload missing required name', () => {
  const res = validateSuggestionPayload('activity', {
    owner_id: '22222222-2222-4222-8222-222222222222',
    source_bullet_id: null,
    occurred_at: 1_700_000_000_000,
    tracker_id: null,
    notes: null,
    quantity: null,
    unit: null,
  })
  expect(res.success).toBe(false)
})
