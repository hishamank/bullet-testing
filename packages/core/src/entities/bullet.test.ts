import { expect, test } from 'vitest'
import { bulletInsertSchema, bulletSelectSchema } from './bullet'

const validBullet = {
  id: '11111111-1111-4111-8111-111111111111',
  owner_id: '22222222-2222-4222-8222-222222222222',
  text: 'ran 5k this morning',
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
  state: 'active' as const,
}

test('bullet select: valid object parses', () => {
  expect(bulletSelectSchema.parse(validBullet)).toEqual(validBullet)
})

test('bullet select: rejects empty text', () => {
  expect(bulletSelectSchema.safeParse({ ...validBullet, text: '' }).success).toBe(false)
})

test('bullet select: rejects bad state enum value', () => {
  expect(bulletSelectSchema.safeParse({ ...validBullet, state: 'archived' }).success).toBe(false)
})

test('bullet select: rejects missing required field (owner_id)', () => {
  const { owner_id, ...rest } = validBullet
  void owner_id
  expect(bulletSelectSchema.safeParse(rest).success).toBe(false)
})

test('bullet select: rejects negative timestamp', () => {
  expect(bulletSelectSchema.safeParse({ ...validBullet, created_at: -5 }).success).toBe(false)
})

test('bullet insert: allows omitting id/created_at/updated_at/state', () => {
  const res = bulletInsertSchema.safeParse({
    owner_id: validBullet.owner_id,
    text: 'a thought',
  })
  expect(res.success).toBe(true)
})
