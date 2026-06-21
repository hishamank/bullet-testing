import { expect, test } from 'vitest'
import { taskInsertSchema, taskSelectSchema } from './task'

const validTask = {
  id: '11111111-1111-4111-8111-111111111111',
  owner_id: '22222222-2222-4222-8222-222222222222',
  source_bullet_id: '33333333-3333-4333-8333-333333333333',
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
  state: 'active' as const,
  status: 'todo' as const,
  title: 'Call the dentist',
  notes: null,
  due_at: null,
  priority: null,
}

test('task select: valid object parses; source_bullet_id may be null', () => {
  expect(taskSelectSchema.parse(validTask)).toEqual(validTask)
  expect(
    taskSelectSchema.parse({ ...validTask, source_bullet_id: null }).source_bullet_id,
  ).toBeNull()
})

test('task select: rejects bad status enum value', () => {
  expect(taskSelectSchema.safeParse({ ...validTask, status: 'blocked' }).success).toBe(false)
})

test('task select: rejects bad priority enum value', () => {
  expect(taskSelectSchema.safeParse({ ...validTask, priority: 'P9' }).success).toBe(false)
})

test('task select: rejects empty title', () => {
  expect(taskSelectSchema.safeParse({ ...validTask, title: '' }).success).toBe(false)
})

test('task select: rejects missing required field (title)', () => {
  const { title, ...rest } = validTask
  void title
  expect(taskSelectSchema.safeParse(rest).success).toBe(false)
})

test('task select: rejects non-integer due_at', () => {
  expect(taskSelectSchema.safeParse({ ...validTask, due_at: 1.25 }).success).toBe(false)
})

test('task insert: allows omitting id/created_at/updated_at/state and defaults status to todo', () => {
  const res = taskInsertSchema.safeParse({
    owner_id: validTask.owner_id,
    source_bullet_id: null,
    title: 'Buy milk',
    notes: null,
    due_at: null,
    priority: null,
  })
  expect(res.success).toBe(true)
  if (res.success) {
    expect(res.data.status).toBe('todo')
  }
})
