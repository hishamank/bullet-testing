import { expect, test } from 'vitest'
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

test('jobs: claimNext returns oldest first, then markFailed', () => {
  const { db } = createTestDb()
  const first = enqueueJob(db, { type: 'extract_bullet', payload: { n: 1 }, owner_id: 'o1' })
  enqueueJob(db, { type: 'extract_bullet', payload: { n: 2 } })

  const claimed = claimNextJob(db)
  expect(claimed?.id).toBe(first.id) // oldest first
  expect(claimed?.owner_id).toBe('o1')

  const failed = markJobFailed(db, first.id, 'boom')
  expect(failed?.status).toBe('failed')
  expect(failed?.error).toBe('boom')
  expect(getJobById(db, first.id)?.status).toBe('failed')
})

test('jobs: claimNext on empty queue returns undefined', () => {
  const { db } = createTestDb()
  expect(claimNextJob(db)).toBeUndefined()
})
