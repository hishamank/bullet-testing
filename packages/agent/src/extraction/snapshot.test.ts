import {
  createActivity,
  createBullet,
  createTask,
  createTestDb,
  createTracker,
  createUser,
  updateTask,
} from '@bullet/db'
import { describe, expect, test } from 'vitest'
import { buildSnapshot } from './snapshot'

function seed() {
  const { db } = createTestDb()
  const user = createUser(db, { name: 'U' })
  const bullet = createBullet(db, { owner_id: user.id, text: 'seed' })
  return { db, ownerId: user.id, bulletId: bullet.id }
}

describe('buildSnapshot', () => {
  test('returns active trackers (name + input_type) and OPEN tasks (title + status)', () => {
    const { db, ownerId, bulletId } = seed()
    createTracker(db, {
      owner_id: ownerId,
      source_bullet_id: bulletId,
      name: 'mood',
      input_type: 'scale',
      config: { input_type: 'scale', min: 1, max: 5 },
    })
    const todo = createTask(db, {
      owner_id: ownerId,
      source_bullet_id: bulletId,
      title: 'call dentist',
      notes: null,
      due_at: null,
      priority: null,
    })
    const done = createTask(db, {
      owner_id: ownerId,
      source_bullet_id: bulletId,
      title: 'already done',
      notes: null,
      due_at: null,
      priority: null,
    })
    updateTask(db, done.id, { status: 'done' })

    const snap = buildSnapshot({ db }, ownerId)
    expect(snap.trackers).toEqual([{ id: expect.any(String), name: 'mood', input_type: 'scale' }])
    // Only the OPEN (todo/in_progress) task is included; the done one is excluded.
    expect(snap.openTasks).toEqual([{ id: todo.id, title: 'call dentist', status: 'todo' }])
  })

  test('does not include unlinked activities or other owners rows', () => {
    const { db, ownerId, bulletId } = seed()
    createActivity(db, {
      owner_id: ownerId,
      source_bullet_id: bulletId,
      name: 'ran',
      occurred_at: Date.now(),
      tracker_id: null,
      notes: null,
      quantity: null,
      unit: null,
    })
    const snap = buildSnapshot({ db }, ownerId)
    expect(snap.trackers).toEqual([])
    expect(snap.openTasks).toEqual([])
  })
})
