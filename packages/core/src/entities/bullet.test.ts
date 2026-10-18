import { expect, test } from 'vite-plus/test'
import { bulletInsertSchema, bulletSelectSchema } from './bullet'

const validBullet = {
  id: '11111111-1111-4111-8111-111111111111',
  owner_id: '22222222-2222-4222-8222-222222222222',
  text: 'ran 5k this morning',
  captured_at: 1_699_999_000_000,
  timezone: 'Europe/Paris',
  source: 'text' as const,
  text_edited_by_user: false,
  answers_question_id: null,
  resolves_thought_id: null,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
  state: 'active' as const,
  processing: {
    status: 'synced' as const,
    attempts: 0,
    error: null,
    next_retry_at: null,
    updated_at: 1_700_000_000_000,
  },
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

test('bullet select: accepts voice source, rejects unknown source', () => {
  expect(bulletSelectSchema.safeParse({ ...validBullet, source: 'voice' }).success).toBe(true)
  expect(bulletSelectSchema.safeParse({ ...validBullet, source: 'email' }).success).toBe(false)
})

test('bullet select: timezone must look like an IANA zone', () => {
  for (const tz of ['UTC', 'America/Argentina/Buenos_Aires', 'Etc/GMT+5', 'Asia/Kolkata']) {
    expect(bulletSelectSchema.safeParse({ ...validBullet, timezone: tz }).success).toBe(true)
  }
  for (const tz of ['', '+02:00', 'Europe/', 'not a zone']) {
    expect(bulletSelectSchema.safeParse({ ...validBullet, timezone: tz }).success).toBe(false)
  }
})

test('bullet select: a failed bullet carries an error code and attempt count', () => {
  const failed = {
    ...validBullet,
    processing: {
      ...validBullet.processing,
      status: 'failed' as const,
      attempts: 3,
      error: { code: 'llm_timeout' as const, message: 'no answer in 120s' },
    },
  }
  expect(bulletSelectSchema.parse(failed).processing.error?.code).toBe('llm_timeout')
})

test('bullet insert: requires capture fields; source defaults to text', () => {
  const res = bulletInsertSchema.safeParse({
    owner_id: validBullet.owner_id,
    text: 'a thought',
    captured_at: 1,
    timezone: 'UTC',
  })
  expect(res.success).toBe(true)
  if (res.success) expect(res.data.source).toBe('text')
  expect(bulletInsertSchema.safeParse({ owner_id: validBullet.owner_id, text: 'x' }).success).toBe(
    false,
  )
})
