import { expect, test } from 'vitest'
import { createTestDb } from '../client'
import { seedOwnerAndBullet } from '../test-helpers'
import {
  createActivity,
  getActivityById,
  listActivities,
  softDeleteActivity,
  updateActivity,
} from './activities'
import { createBullet, getBulletById, listBullets, softDeleteBullet, updateBullet } from './bullets'
import {
  createSuggestion,
  getSuggestionById,
  listSuggestions,
  softDeleteSuggestion,
} from './suggestions'
import { createTask, getTaskById, listTasks, softDeleteTask, updateTask } from './tasks'
import {
  createTrackerEntry,
  getTrackerEntryById,
  listEntriesByTracker,
  listTrackerEntries,
  softDeleteTrackerEntry,
} from './trackerEntries'
import {
  createTracker,
  getTrackerById,
  listTrackers,
  softDeleteTracker,
  updateTracker,
} from './trackers'
import { createUser, getUserById, listUsers, updateUser } from './users'

test('users: create → getById → list → update', () => {
  const { db } = createTestDb()
  const u = createUser(db, { name: 'Ada' })
  expect(getUserById(db, u.id)?.name).toBe('Ada')
  expect(listUsers(db).length).toBe(1)
  const updated = updateUser(db, u.id, { name: 'Ada L.' })
  expect(updated?.name).toBe('Ada L.')
  expect(updated?.updated_at).toBeGreaterThanOrEqual(u.updated_at)
})

test('bullets: round-trip + soft-delete excluded from list; owner scoping', () => {
  const { db } = createTestDb()
  const a = createUser(db, { name: 'A' })
  const b = createUser(db, { name: 'B' })
  const ba = createBullet(db, { owner_id: a.id, text: 'a-bullet' })
  createBullet(db, { owner_id: b.id, text: 'b-bullet' })

  expect(listBullets(db, a.id).map((x) => x.id)).toEqual([ba.id]) // owner-scoped
  expect(getBulletById(db, ba.id)?.text).toBe('a-bullet')

  const renamed = updateBullet(db, ba.id, { text: 'a-bullet-edited' })
  expect(renamed?.text).toBe('a-bullet-edited')

  softDeleteBullet(db, ba.id)
  expect(listBullets(db, a.id)).toHaveLength(0) // excluded by default
  expect(listBullets(db, a.id, { includeDeleted: true })).toHaveLength(1)
  expect(getBulletById(db, ba.id)?.state).toBe('deleted')
})

test('tasks: full CRUD round-trip', () => {
  const { db } = createTestDb()
  const { ownerId, bulletId } = seedOwnerAndBullet(db)
  const t = createTask(db, {
    owner_id: ownerId,
    source_bullet_id: bulletId,
    title: 'Call dentist',
    notes: null,
    due_at: null,
    priority: null,
  })
  expect(t.status).toBe('todo') // server default applied
  expect(getTaskById(db, t.id)?.title).toBe('Call dentist')
  expect(listTasks(db, ownerId)).toHaveLength(1)

  const done = updateTask(db, t.id, { status: 'done' })
  expect(done?.status).toBe('done')

  softDeleteTask(db, t.id)
  expect(listTasks(db, ownerId)).toHaveLength(0)
})

test('trackers + entries: CRUD + entries-by-tracker', () => {
  const { db } = createTestDb()
  const { ownerId, bulletId } = seedOwnerAndBullet(db)
  const tr = createTracker(db, {
    owner_id: ownerId,
    source_bullet_id: bulletId,
    name: 'Mood',
    input_type: 'scale',
    config: { input_type: 'scale', min: 1, max: 5 },
  })
  expect(getTrackerById(db, tr.id)?.name).toBe('Mood')
  expect(updateTracker(db, tr.id, { name: 'Daily Mood' })?.name).toBe('Daily Mood')

  const e = createTrackerEntry(db, {
    owner_id: ownerId,
    source_bullet_id: bulletId,
    tracker_id: tr.id,
    value: 4,
    logged_at: Date.now(),
  })
  expect(listTrackerEntries(db, ownerId)).toHaveLength(1)
  expect(listEntriesByTracker(db, tr.id).map((x) => x.id)).toEqual([e.id])

  softDeleteTrackerEntry(db, e.id)
  expect(listEntriesByTracker(db, tr.id)).toHaveLength(0)
  softDeleteTracker(db, tr.id)
  expect(listTrackers(db, ownerId)).toHaveLength(0)
})

test('activities: CRUD round-trip (linked + free fields)', () => {
  const { db } = createTestDb()
  const { ownerId, bulletId } = seedOwnerAndBullet(db)
  const act = createActivity(db, {
    owner_id: ownerId,
    source_bullet_id: bulletId,
    name: 'Run',
    occurred_at: Date.now(),
    tracker_id: null,
    notes: 'felt great',
    quantity: 5,
    unit: 'km',
  })
  expect(getActivityById(db, act.id)?.quantity).toBe(5)
  expect(updateActivity(db, act.id, { quantity: 6 })?.quantity).toBe(6)
  expect(listActivities(db, ownerId)).toHaveLength(1)
  softDeleteActivity(db, act.id)
  expect(listActivities(db, ownerId)).toHaveLength(0)
})

test('suggestions: create → list → soft-delete', () => {
  const { db } = createTestDb()
  const { ownerId, bulletId } = seedOwnerAndBullet(db)
  const s = createSuggestion(db, {
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
  expect(s.status).toBe('pending') // server default
  expect(listSuggestions(db, ownerId)).toHaveLength(1)
  softDeleteSuggestion(db, s.id)
  expect(listSuggestions(db, ownerId)).toHaveLength(0)
})

test('JSON columns round-trip non-scalar shapes through SQLite (config/value/payload)', () => {
  const { db } = createTestDb()
  const { ownerId, bulletId } = seedOwnerAndBullet(db)

  // trackers.config — a nested object with an array. Reads back deep-equal (would break if the
  // `{ mode: 'json' }` text-serialisation were ever dropped and the value stringified).
  const config = { input_type: 'multi_select', options: ['a', 'b'] } as const
  const tr = createTracker(db, {
    owner_id: ownerId,
    source_bullet_id: bulletId,
    name: 'Symptoms',
    input_type: 'multi_select',
    config,
  })
  expect(getTrackerById(db, tr.id)?.config).toEqual(config)

  // tracker_entries.value — an array value round-trips back as an array, not a string.
  const value = ['a', 'b']
  const entry = createTrackerEntry(db, {
    owner_id: ownerId,
    source_bullet_id: bulletId,
    tracker_id: tr.id,
    value,
    logged_at: Date.now(),
  })
  expect(getTrackerEntryById(db, entry.id)?.value).toEqual(value)

  // suggestions.payload — a non-trivial object round-trips deep-equal.
  const payload = {
    owner_id: ownerId,
    source_bullet_id: bulletId,
    title: 'multi',
    notes: 'two\nlines',
    due_at: 1_700_000_000_000,
    priority: 'P2' as const,
  }
  const s = createSuggestion(db, {
    owner_id: ownerId,
    source_bullet_id: bulletId,
    target_kind: 'task',
    operation: 'create',
    target_id: null,
    payload,
    confidence: 0.9,
    tier: 'suggest',
    resolved_at: null,
  })
  expect(getSuggestionById(db, s.id)?.payload).toEqual(payload)
})

test('repositories reject invalid insert input with a typed DbError', () => {
  const { db } = createTestDb()
  const { ownerId, bulletId } = seedOwnerAndBullet(db)
  // Empty title violates the core insert schema (nonEmptyString).
  expect(() =>
    createTask(db, {
      owner_id: ownerId,
      source_bullet_id: bulletId,
      title: '',
      notes: null,
      due_at: null,
      priority: null,
    }),
  ).toThrow(/validation/i)
})
