import { describe, expect, test } from 'vitest'
import { appRouter } from './routers'
import { activityPlusTaskScript, buildTestDeps, reconcileScript } from './test-helpers'
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

  test('suggestions.edit applies the modified payload and preserves provenance', async () => {
    const deps = buildTestDeps(activityPlusTaskScript())
    const caller = createCaller(deps)

    const bullet = await caller.bullets.create({ text: 'ran 5k, call the dentist' })
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
    // Provenance survives the edit: the applied task still traces to the originating bullet
    // (editing the payload must not sever the source_bullet_id), mirroring the accept test.
    expect(tasks[0]?.source_bullet_id).toBe(bullet.id)

    // The edited suggestion is resolved — no longer pending.
    expect(await caller.suggestions.listPending()).toHaveLength(0)
  })

  test('bullets.update re-runs extraction and RECONCILES against applied entities (§4.7)', async () => {
    // A single scripted client serves BOTH the create-extraction and the update-reprocess via a
    // FIFO chat queue, because the same runtime handles both passes.
    const deps = buildTestDeps(reconcileScript())
    const caller = createCaller(deps)

    // 1) Create a bullet → drain. Pass 1 yields an auto activity ("ran 5k", auto-applied) plus a
    //    suggest task ("call the dentist", pending).
    const bullet = await caller.bullets.create({ text: 'ran 5k, call the dentist' })
    expect(await deps.runtime.worker.drain()).toBe(1)

    const activitiesBefore = await caller.activities.list()
    expect(activitiesBefore).toHaveLength(1)
    const keptActivityId = activitiesBefore[0]?.id
    expect(activitiesBefore[0]?.name).toBe('ran 5k')

    const pendingBefore = await caller.suggestions.listPending()
    expect(pendingBefore).toHaveLength(1)
    const retiredSuggestionId = pendingBefore[0]?.id
    expect(pendingBefore[0]?.target_kind).toBe('task')

    // 2) Edit the bullet → the SECOND scripted response keeps "ran 5k", drops "call the dentist",
    //    and adds a new "swam 1k". The procedure runs updateBullet + runtime.reprocessBullet.
    const { bullet: updatedBullet, reconcile } = await caller.bullets.update({
      id: bullet.id,
      text: 'ran 5k, swam 1k',
    })
    expect(updatedBullet.text).toBe('ran 5k, swam 1k')

    // 3) Assert the RECONCILE RESULT returned to the caller:
    //    - the matched activity was KEPT (not duplicated),
    //    - the new candidate was ADDED + auto-applied,
    //    - the stale pending task suggestion was RETIRED,
    //    - nothing was retired as a removed APPLIED entity ("ran 5k" still matches).
    expect(reconcile.keptEntityIds).toEqual(keptActivityId ? [keptActivityId] : [])
    expect(reconcile.newSuggestionIds).toHaveLength(1)
    expect(reconcile.appliedIds).toHaveLength(1)
    expect(reconcile.retiredPendingIds).toEqual(retiredSuggestionId ? [retiredSuggestionId] : [])
    expect(reconcile.retiredEntityIds).toHaveLength(0)
    expect(reconcile.failedAutoApplyIds).toHaveLength(0)

    // 4) Assert DB STATE actually reconciled (not blindly recreated):
    //    The kept activity is the SAME row (same id) and unchanged/active — proof of a match, not
    //    a delete-and-recreate. The new activity ("swam 1k") is present. There are exactly two
    //    active activities (no duplicate "ran 5k").
    const activitiesAfter = await caller.activities.list()
    expect(activitiesAfter).toHaveLength(2)
    const names = activitiesAfter.map((a) => a.name).sort()
    expect(names).toEqual(['ran 5k', 'swam 1k'])
    const keptAfter = activitiesAfter.find((a) => a.id === keptActivityId)
    expect(keptAfter?.name).toBe('ran 5k')
    expect(keptAfter?.state).toBe('active')

    // The retired (dropped) task suggestion is gone from pending; the new auto activity left
    // nothing pending either — so there are no pending suggestions after the reconcile.
    expect(await caller.suggestions.listPending()).toHaveLength(0)
    // And no task was ever applied (the dropped suggestion was never accepted).
    expect(await caller.tasks.list()).toHaveLength(0)
  })
})
