import { expect, test } from 'vitest'
import { userInsertSchema, userSelectSchema } from './user'

const validUser = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Hicham',
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
}

test('user select: valid object parses, name may be null', () => {
  expect(userSelectSchema.parse(validUser)).toEqual(validUser)
  expect(userSelectSchema.parse({ ...validUser, name: null }).name).toBeNull()
})

test('user select: rejects non-uuid id', () => {
  expect(userSelectSchema.safeParse({ ...validUser, id: 'not-a-uuid' }).success).toBe(false)
})

test('user select: rejects negative / non-integer timestamps', () => {
  expect(userSelectSchema.safeParse({ ...validUser, created_at: -1 }).success).toBe(false)
  expect(userSelectSchema.safeParse({ ...validUser, updated_at: 1.5 }).success).toBe(false)
})

test('user insert: allows omitting id/created_at/updated_at', () => {
  const res = userInsertSchema.safeParse({ name: 'Hicham' })
  expect(res.success).toBe(true)
})
