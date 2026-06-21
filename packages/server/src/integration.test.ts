import { describe, expect, test } from 'vitest'
import { appRouter } from './routers'
import { activityPlusTaskScript, buildTestDeps } from './test-helpers'
import { createCallerFactory } from './trpc'

const createCaller = createCallerFactory(appRouter)

describe('bullet → extraction → suggestion → accept (end-to-end through the caller)', () => {
  test('create → drain → auto-apply + pending → accept → entity exists with provenance', async () => {
    const deps = buildTestDeps(activityPlusTaskScript())
    const caller = createCaller(deps)

    // 1) Create a bullet — this enqueues an extraction job.
    const bullet = await caller.bullets.create({ text: 'ran 5k, call the dentist' })
    expect(bullet.text).toBe('ran 5k, call the dentist')
    expect(bullet.owner_id).toBe(deps.ownerId)

    // 2) Drain the worker — the scripted model yields one auto activity + one suggest task.
    const processed = await deps.runtime.worker.drain()
    expect(processed).toBe(1)

    // 3) The high-confidence ACTIVITY was auto-applied by the worker (tier 'auto') — so it is
    //    already a real entity and NOT pending.
    const activities = await caller.activities.list()
    expect(activities).toHaveLength(1)
    expect(activities[0]?.name).toBe('ran 5k')
    // Provenance: the auto-applied entity traces back to the bullet.
    expect(activities[0]?.source_bullet_id).toBe(bullet.id)

    // 4) The TASK suggestion is pending (tasks are never auto-applied with the default config).
    const pending = await caller.suggestions.listPending()
    expect(pending).toHaveLength(1)
    const taskSuggestion = pending[0]
    expect(taskSuggestion?.target_kind).toBe('task')
    expect(taskSuggestion?.tier).toBe('suggest')
    // No task exists yet — the suggestion has not been accepted.
    expect(await caller.tasks.list()).toHaveLength(0)

    // 5) Accept the pending suggestion → the task entity now exists with correct provenance.
    if (!taskSuggestion) throw new Error('expected a pending task suggestion')
    const accepted = await caller.suggestions.accept({ id: taskSuggestion.id })
    expect(accepted.suggestion.status).toBe('accepted')

    const tasks = await caller.tasks.list()
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.title).toBe('call the dentist')
    expect(tasks[0]?.source_bullet_id).toBe(bullet.id)

    // The accepted suggestion is no longer pending.
    expect(await caller.suggestions.listPending()).toHaveLength(0)
  })

  test('suggestions.reject resolves without applying anything', async () => {
    const deps = buildTestDeps(activityPlusTaskScript())
    const caller = createCaller(deps)

    await caller.bullets.create({ text: 'ran 5k, call the dentist' })
    await deps.runtime.worker.drain()

    const pending = await caller.suggestions.listPending()
    const suggestion = pending[0]
    if (!suggestion) throw new Error('expected a pending suggestion')

    const rejected = await caller.suggestions.reject({ id: suggestion.id })
    expect(rejected.status).toBe('rejected')
    // Nothing applied — still no task.
    expect(await caller.tasks.list()).toHaveLength(0)
    expect(await caller.suggestions.listPending()).toHaveLength(0)
  })

  test('suggestions.edit applies the modified payload', async () => {
    const deps = buildTestDeps(activityPlusTaskScript())
    const caller = createCaller(deps)

    await caller.bullets.create({ text: 'ran 5k, call the dentist' })
    await deps.runtime.worker.drain()

    const suggestion = (await caller.suggestions.listPending())[0]
    if (!suggestion) throw new Error('expected a pending suggestion')

    // The edit payload is the existing one with a modified title (the UI edits in place). The
    // payload must remain a valid full task insert — provenance fields are preserved.
    const edited = await caller.suggestions.edit({
      id: suggestion.id,
      payload: { ...suggestion.payload, title: 'call the orthodontist' },
    })
    expect(edited.suggestion.status).toBe('edited')

    const tasks = await caller.tasks.list()
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.title).toBe('call the orthodontist')
  })
})
