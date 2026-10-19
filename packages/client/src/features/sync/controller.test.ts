import { describe, expect, test } from 'vite-plus/test'
import { captureBullet } from '../../data/local'
import { createSyncClient } from '../../sync/client'
import { TransportError } from '../../sync/transport'
import { FakeServer } from '../../test/fake-server'
import { openTestDb, testDeps } from '../../test/db'
import { createSyncController } from './controller'
import { POLL } from './monitor'

function setup(foreground = true) {
  const db = openTestDb()
  const deps = testDeps()
  const server = new FakeServer()
  const timers: { fn: () => void; ms: number }[] = []
  // The client reports every outcome to the controller, like the apps' wiring does.
  const client = createSyncClient({
    db,
    transport: () => server,
    onOutcome: (o) => controller.onOutcome(o),
    setTimer: () => null,
    clearTimer: () => {},
  })
  const controller = createSyncController({
    db: () => db,
    client: () => client,
    foreground,
    setTimer: (fn, ms) => {
      const t = { fn, ms }
      timers.push(t)
      return t
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h as (typeof timers)[number])
      if (i >= 0) timers.splice(i, 1)
    },
  })
  return { db, deps, server, timers, controller }
}

describe('sync controller', () => {
  test('does nothing until paired', async () => {
    const t = setup()
    await t.controller.syncNow()
    expect(t.server.pushCalls).toBe(0)
    expect(t.controller.pairingStore.get()).toBe('loading')
  })

  test('paired: syncs, records the outcome, bumps live queries and schedules the next sync', async () => {
    const t = setup()
    const before = t.controller.changeStore.get()
    captureBullet(t.db, { text: 'a made-up thought' }, t.deps)
    t.controller.pairingStore.set('paired')
    const seen: boolean[] = []
    t.controller.syncingStore.subscribe(() => seen.push(t.controller.syncingStore.get()))
    await t.controller.syncNow()
    expect(t.server.pushCalls).toBe(1)
    expect(t.controller.monitorStore.get().reachability).toBe('ok')
    expect(t.controller.changeStore.get()).toBeGreaterThan(before)
    expect(seen).toEqual([true, false])
    // The capture is waiting on the server's reading: check back soon.
    expect(t.timers.at(-1)?.ms).toBe(POLL.awaitingMs)
    // Once it is processed nothing waits: the gentle idle poll.
    const id = [...t.server.bullets.keys()][0] ?? ''
    t.server.process(id, 'processed')
    await t.controller.syncNow()
    expect(t.timers.at(-1)?.ms).toBe(POLL.idleMs)
  })

  test('a hidden tab schedules nothing; coming back to the front schedules again', async () => {
    const t = setup(false)
    t.controller.pairingStore.set('paired')
    await t.controller.syncNow()
    expect(t.timers).toHaveLength(0)
    t.controller.setForeground(true)
    await t.controller.syncNow()
    expect(t.timers).toHaveLength(1)
    t.controller.setForeground(false)
    expect(t.timers).toHaveLength(0)
  })

  test('failures back off, and two in a row make an outage', async () => {
    const t = setup()
    t.controller.pairingStore.set('paired')
    t.server.failNext = { count: 5, error: new TransportError('network', 'down') }
    await t.controller.syncNow()
    expect(t.controller.monitorStore.get().reachability).toBe('unknown')
    expect(t.timers.at(-1)?.ms).toBe(POLL.failureBaseMs)
    await t.controller.syncNow()
    expect(t.controller.monitorStore.get().reachability).toBe('unreachable')
    expect(t.timers.at(-1)?.ms).toBe(POLL.failureBaseMs * 2)
  })

  test('paired() forgets the old server; unpaired() stops everything', async () => {
    const t = setup()
    t.controller.pairingStore.set('paired')
    t.server.failNext = { count: 5, error: new TransportError('unauthorized', 'no', 401) }
    await t.controller.syncNow()
    expect(t.controller.monitorStore.get().reachability).toBe('unauthorized')
    t.server.failNext = null
    t.controller.paired()
    expect(t.controller.monitorStore.get().reachability).toBe('unknown')
    await t.controller.syncNow()
    expect(t.controller.monitorStore.get().reachability).toBe('ok')
    t.controller.unpaired()
    expect(t.controller.pairingStore.get()).toBe('unpaired')
    expect(t.timers).toHaveLength(0)
    const calls = t.server.pushCalls
    await t.controller.syncNow()
    expect(t.server.pushCalls).toBe(calls)
  })
})
