import { afterEach, expect, test, vi } from 'vitest'
import { createTestDb } from '../client'
import {
  claimNextJob,
  enqueueJob,
  getJobById,
  listJobsByStatus,
  markJobDone,
  markJobFailed,
} from './jobs'

test('jobs: enqueue → claimNext → markDone lifecycle', () => {
  const { db } = createTestDb()
  const job = enqueueJob(db, { type: 'extract_bullet', payload: { bullet_id: 'b1' } })
  expect(job.status).toBe('queued')
  expect(listJobsByStatus(db, 'queued')).toHaveLength(1)

  const claimed = claimNextJob(db)
  expect(claimed?.id).toBe(job.id)
  expect(claimed?.status).toBe('running')
  expect(claimed?.attempts).toBe(1)
  expect(claimed?.started_at).toBeTypeOf('number')
  expect(listJobsByStatus(db, 'queued')).toHaveLength(0)

  const done = markJobDone(db, job.id)
  expect(done?.status).toBe('done')
  expect(done?.finished_at).toBeTypeOf('number')
})

afterEach(() => {
  vi.useRealTimers()
})

test('jobs: claimNext returns oldest first, then markFailed', () => {
  const { db } = createTestDb()
  // Pin the clock so the two jobs get DISTINCT created_at values — "oldest first" is then
  // well-defined and the (created_at, id) tiebreak's id leg never engages. Without this the
  // two enqueues can share a millisecond and ordering would (wrongly) depend on rowids.
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  const first = enqueueJob(db, { type: 'extract_bullet', payload: { n: 1 }, owner_id: 'o1' })
  vi.setSystemTime(2_000)
  enqueueJob(db, { type: 'extract_bullet', payload: { n: 2 } })

  const claimed = claimNextJob(db)
  expect(claimed?.id).toBe(first.id) // oldest first
  expect(claimed?.owner_id).toBe('o1')

  const failed = markJobFailed(db, first.id, 'boom')
  expect(failed?.status).toBe('failed')
  expect(failed?.error).toBe('boom')
  expect(getJobById(db, first.id)?.status).toBe('failed')
})

test('jobs: claimNext / listJobsByStatus break created_at ties deterministically by id', () => {
  const { db } = createTestDb()
  // Two jobs enqueued in the SAME millisecond: their order must be the stable (created_at, id)
  // ordering, NOT incidental rowid order.
  vi.useFakeTimers()
  vi.setSystemTime(5_000)
  const a = enqueueJob(db, { type: 'extract_bullet', payload: { n: 1 } })
  const b = enqueueJob(db, { type: 'extract_bullet', payload: { n: 2 } })

  const expectedFirst = a.id < b.id ? a.id : b.id
  expect(listJobsByStatus(db, 'queued').map((j) => j.id)).toEqual(
    [a.id, b.id].sort(), // ascending id (created_at is equal)
  )
  expect(claimNextJob(db)?.id).toBe(expectedFirst)
})

test('jobs: claimNext on empty queue returns undefined', () => {
  const { db } = createTestDb()
  expect(claimNextJob(db)).toBeUndefined()
})
