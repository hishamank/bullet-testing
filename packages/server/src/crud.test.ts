import { describe, expect, test } from 'vitest'
import { appRouter } from './routers'
import { activityPlusTaskScript, buildTestDeps } from './test-helpers'
import { createCallerFactory } from './trpc'

const createCaller = createCallerFactory(appRouter)

describe('system router', () => {
  test('health + echo round-trip', async () => {
    const caller = createCaller(buildTestDeps())
    const health = await caller.system.health()
    expect(health.ok).toBe(true)
    expect(typeof health.now).toBe('number')
    expect(await caller.system.echo({ message: 'hi' })).toEqual({ message: 'hi' })
  })
})

describe('tasks CRUD round-trip', () => {
  test('create → list → update → delete', async () => {
    const caller = createCaller(buildTestDeps())

    const created = await caller.tasks.create({
      title: 'write tests',
      notes: null,
      due_at: null,
      priority: 'P2',
    })
    expect(created.title).toBe('write tests')
    // Manually-created → null provenance, owner-scoped.
    expect(created.source_bullet_id).toBeNull()

    expect(await caller.tasks.list()).toHaveLength(1)

    const updated = await caller.tasks.update({ id: created.id, status: 'done' })
    expect(updated.status).toBe('done')
    // Unchanged fields are preserved.
    expect(updated.title).toBe('write tests')

    const deleted = await caller.tasks.delete({ id: created.id })
    expect(deleted.state).toBe('deleted')
    expect(await caller.tasks.list()).toHaveLength(0)
  })
})

describe('trackers + trackerEntries CRUD round-trip', () => {
  test('a number tracker, an entry, then updates and deletes', async () => {
    const caller = createCaller(buildTestDeps())

    const tracker = await caller.trackers.create({
      name: 'water',
      input_type: 'number',
      config: { input_type: 'number', unit: 'glasses' },
    })
    expect(tracker.name).toBe('water')
    expect(await caller.trackers.list()).toHaveLength(1)

    const entry = await caller.trackerEntries.create({
      tracker_id: tracker.id,
      value: 3,
      logged_at: Date.now(),
    })
    expect(entry.tracker_id).toBe(tracker.id)
    expect(entry.value).toBe(3)

    const updatedEntry = await caller.trackerEntries.update({ id: entry.id, value: 5 })
    expect(updatedEntry.value).toBe(5)

    const updatedTracker = await caller.trackers.update({ id: tracker.id, name: 'hydration' })
    expect(updatedTracker.name).toBe('hydration')

    expect((await caller.trackerEntries.delete({ id: entry.id })).state).toBe('deleted')
    expect((await caller.trackers.delete({ id: tracker.id })).state).toBe('deleted')
    expect(await caller.trackers.list()).toHaveLength(0)
    expect(await caller.trackerEntries.list()).toHaveLength(0)
  })
})

describe('activities CRUD round-trip', () => {
  test('create → update → delete', async () => {
    const caller = createCaller(buildTestDeps())

    const created = await caller.activities.create({
      name: 'meditated',
      occurred_at: Date.now(),
      tracker_id: null,
      notes: null,
      quantity: null,
      unit: null,
    })
    expect(created.name).toBe('meditated')
    expect(created.source_bullet_id).toBeNull()

    const updated = await caller.activities.update({ id: created.id, notes: '10 minutes' })
    expect(updated.notes).toBe('10 minutes')

    expect((await caller.activities.delete({ id: created.id })).state).toBe('deleted')
    expect(await caller.activities.list()).toHaveLength(0)
  })
})

describe('bullets.delete modes (§4.6)', () => {
  test('cascade soft-deletes the bullet AND its extractions', async () => {
    const deps = buildTestDeps(activityPlusTaskScript())
    const caller = createCaller(deps)

    const bullet = await caller.bullets.create({ text: 'ran 5k, call the dentist' })
    await deps.runtime.worker.drain()

    // The auto-applied activity exists before deletion.
    expect(await caller.activities.list()).toHaveLength(1)
    expect(await caller.suggestions.listPending()).toHaveLength(1)

    const result = await caller.bullets.delete({ id: bullet.id, mode: 'cascade' })
    expect(result.mode).toBe('cascade')
    expect(result.bulletDeleted).toBe(true)
    expect(result.cascadedIds.length).toBeGreaterThan(0)

    // Everything traced to the bullet is gone.
    expect(await caller.bullets.list()).toHaveLength(0)
    expect(await caller.activities.list()).toHaveLength(0)
    expect(await caller.suggestions.listPending()).toHaveLength(0)
  })

  test('keep soft-deletes only the bullet; extractions survive', async () => {
    const deps = buildTestDeps(activityPlusTaskScript())
    const caller = createCaller(deps)

    const bullet = await caller.bullets.create({ text: 'ran 5k, call the dentist' })
    await deps.runtime.worker.drain()
    expect(await caller.activities.list()).toHaveLength(1)

    const result = await caller.bullets.delete({ id: bullet.id, mode: 'keep' })
    expect(result.mode).toBe('keep')
    expect(result.bulletDeleted).toBe(true)
    expect(result.cascadedIds).toHaveLength(0)

    // The bullet is gone but its extracted activity survives as a standalone entity.
    expect(await caller.bullets.list()).toHaveLength(0)
    expect(await caller.activities.list()).toHaveLength(1)
  })
})
