/**
 * weekly router round-trips — the manual analyzer trigger surfaced over tRPC. Seeds same-named
 * UNLINKED activities (with a source bullet, since a Suggestion needs one), then proves `run`
 * persists a tracker suggestion that flows into `suggestions.listPending`, and that a SECOND `run`
 * is idempotent (adds nothing).
 */

import { createActivity, createBullet } from '@bullet/db'
import { describe, expect, test } from 'vitest'
import type { ServerDeps } from './context'
import { appRouter } from './routers'
import { buildTestDeps } from './test-helpers'
import { createCallerFactory } from './trpc'

const createCaller = createCallerFactory(appRouter)

/** Seed `n` active UNLINKED (tracker_id null) activities under one bullet for the owner. */
function seedUnlinkedActivities(deps: ServerDeps, bulletId: string, name: string, n: number) {
  for (let i = 0; i < n; i++) {
    createActivity(deps.db, {
      owner_id: deps.ownerId,
      source_bullet_id: bulletId,
      name,
      occurred_at: Date.now(),
      tracker_id: null,
      notes: null,
      quantity: null,
      unit: null,
    })
  }
}

describe('weekly router', () => {
  test('run persists a tracker suggestion that surfaces in listPending; a second run adds none', async () => {
    const deps = buildTestDeps()
    const caller = createCaller(deps)

    const bullet = createBullet(deps.db, { owner_id: deps.ownerId, text: 'meditated again' })
    seedUnlinkedActivities(deps, bullet.id, 'meditate', 3)

    const created = await caller.weekly.run()
    expect(created.length).toBeGreaterThanOrEqual(1)
    expect(created[0]?.target_kind).toBe('tracker')
    expect(created[0]?.tier).toBe('suggest')
    expect(created[0]?.status).toBe('pending')

    // The persisted suggestion is now a pending item in the Review inbox.
    const pending = await caller.suggestions.listPending()
    expect(pending.some((s) => s.id === created[0]?.id)).toBe(true)
    const pendingCount = pending.length

    // Idempotent: the name is now covered by a pending tracker suggestion → a re-run adds nothing.
    const again = await caller.weekly.run()
    expect(again).toHaveLength(0)
    expect(await caller.suggestions.listPending()).toHaveLength(pendingCount)
  })
})
