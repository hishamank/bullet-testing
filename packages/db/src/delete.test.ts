import { expect, test } from 'vitest'
import { softDelete } from './apply'
import { createTestDb } from './client'
import { DbError } from './errors'
import { createActivity, getActivityById } from './repositories/activities'
import { createBullet, getBulletById } from './repositories/bullets'
import { createSuggestion, getSuggestionById } from './repositories/suggestions'
import { createTask, getTaskById } from './repositories/tasks'
import { createTrackerEntry, getTrackerEntryById } from './repositories/trackerEntries'
import { createTracker, getTrackerById } from './repositories/trackers'
import { seedOwnerAndBullet } from './test-helpers'

/** Build the full extraction graph traced to `bulletId`. */
function seedExtractions(
  db: ReturnType<typeof createTestDb>['db'],
  ownerId: string,
  bulletId: string,
) {
  const task = createTask(db, {
    owner_id: ownerId,
    source_bullet_id: bulletId,
    title: 'task',
    notes: null,
    due_at: null,
    priority: null,
  })
  const tracker = createTracker(db, {
    owner_id: ownerId,
    source_bullet_id: bulletId,
    name: 'Mood',
    input_type: 'scale',
    config: { input_type: 'scale', min: 1, max: 5 },
  })
  const entry = createTrackerEntry(db, {
    owner_id: ownerId,
    source_bullet_id: bulletId,
    tracker_id: tracker.id,
    value: 3,
    logged_at: Date.now(),
  })
  const activity = createActivity(db, {
    owner_id: ownerId,
    source_bullet_id: bulletId,
    name: 'Run',
    occurred_at: Date.now(),
    tracker_id: null,
    notes: null,
    quantity: null,
    unit: null,
  })
  const suggestion = createSuggestion(db, {
    owner_id: ownerId,
    source_bullet_id: bulletId,
    target_kind: 'task',
    operation: 'create',
    target_id: null,
    payload: {
      owner_id: ownerId,
      source_bullet_id: bulletId,
      title: 'x',
      notes: null,
      due_at: null,
      priority: null,
    },
    confidence: 0.9,
    tier: 'suggest',
    resolved_at: null,
  })
  return { task, tracker, entry, activity, suggestion }
}

test("softDelete 'cancel' is a no-op", () => {
  const { db } = createTestDb()
  const { bulletId } = seedOwnerAndBullet(db)
  const res = softDelete(db, bulletId, 'cancel')
  expect(res.bulletDeleted).toBe(false)
  expect(res.cascadedIds).toHaveLength(0)
  expect(getBulletById(db, bulletId)?.state).toBe('active')
})

test("softDelete 'cascade' soft-deletes the bullet + every traced row (incl suggestions)", () => {
  const { db } = createTestDb()
  const { ownerId, bulletId } = seedOwnerAndBullet(db)
  const { task, tracker, entry, activity, suggestion } = seedExtractions(db, ownerId, bulletId)

  // A row traced to a DIFFERENT bullet must be untouched.
  const otherBullet = createBullet(db, { owner_id: ownerId, text: 'other' })
  const survivor = createTrackerEntry(db, {
    owner_id: ownerId,
    source_bullet_id: otherBullet.id,
    tracker_id: tracker.id,
    value: 2,
    logged_at: Date.now(),
  })

  const res = softDelete(db, bulletId, 'cascade')
  expect(res.bulletDeleted).toBe(true)
  expect(new Set(res.cascadedIds)).toEqual(
    new Set([task.id, tracker.id, entry.id, activity.id, suggestion.id]),
  )

  expect(getBulletById(db, bulletId)?.state).toBe('deleted')
  expect(getTaskById(db, task.id)?.state).toBe('deleted')
  expect(getTrackerById(db, tracker.id)?.state).toBe('deleted')
  expect(getTrackerEntryById(db, entry.id)?.state).toBe('deleted')
  expect(getActivityById(db, activity.id)?.state).toBe('deleted')
  expect(getSuggestionById(db, suggestion.id)?.state).toBe('deleted')

  // The entry from a different bullet is untouched.
  expect(getTrackerEntryById(db, survivor.id)?.state).toBe('active')
})

test("softDelete 'keep' deletes ONLY the bullet; extractions survive with provenance intact", () => {
  const { db } = createTestDb()
  const { ownerId, bulletId } = seedOwnerAndBullet(db)
  const { task, tracker, entry, activity, suggestion } = seedExtractions(db, ownerId, bulletId)

  const res = softDelete(db, bulletId, 'keep')
  expect(res.bulletDeleted).toBe(true)
  expect(res.cascadedIds).toHaveLength(0)

  expect(getBulletById(db, bulletId)?.state).toBe('deleted')
  // Extractions remain active, still pointing at the now-deleted bullet.
  for (const row of [
    getTaskById(db, task.id),
    getTrackerById(db, tracker.id),
    getTrackerEntryById(db, entry.id),
    getActivityById(db, activity.id),
    getSuggestionById(db, suggestion.id),
  ]) {
    expect(row?.state).toBe('active')
    expect(row?.source_bullet_id).toBe(bulletId)
  }
})

test('softDelete throws when the bullet is missing (cascade/keep)', () => {
  const { db } = createTestDb()
  expect(() => softDelete(db, 'missing-bullet', 'cascade')).toThrow(DbError)
  expect(() => softDelete(db, 'missing-bullet', 'keep')).toThrow(DbError)
})
