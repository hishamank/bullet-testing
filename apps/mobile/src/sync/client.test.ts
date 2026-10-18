import { describe, expect, test } from 'vite-plus/test'
import { captureBullet, editBullet, retryBullet } from '../data/local'
import { applyPull, CURSOR_KEY, getState } from '../data/mirror'
import { listBullets } from '../data/queries'
import { bullets, outbox } from '../data/schema'
import { FakeServer } from '../test/fake-server'
import { openTestDb, testDeps } from '../test/db'
import { createSyncClient } from './client'
import { TransportError } from './transport'

function setup(opts: { pullLimit?: number } = {}) {
  const db = openTestDb()
  const server = new FakeServer()
  const deps = testDeps()
  const timers: { fn: () => void; ms: number }[] = []
  const client = createSyncClient({
    db,
    transport: () => server,
    pullLimit: opts.pullLimit,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms })
      return timers.length
    },
    clearTimer: () => {},
  })
  return { db, server, deps, client, timers }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('push + pull', () => {
  test('drains the outbox, then pulls the server status into the stream', async () => {
    const { db, server, deps, client } = setup()
    const id = captureBullet(db, { text: 'ran 5k' }, deps)
    expect(listBullets(db)[0]?.status).toBe('saved_local')

    expect(await client.sync()).toMatchObject({ ok: true, pushed: 1 })
    expect(db.select().from(outbox).all()).toEqual([])
    expect(server.bullets.has(id)).toBe(true)
    expect(listBullets(db)[0]?.status).toBe('synced')

    server.process(id, 'needs_review')
    await client.sync()
    expect(listBullets(db)[0]).toMatchObject({ status: 'needs_review', attempts: 1 })
  })

  test('offline: nothing is lost, the op waits and goes out later', async () => {
    const { db, server, deps, client } = setup()
    captureBullet(db, { text: 'offline thought' }, deps)
    server.failNext = { count: 1, error: new TransportError('network', 'offline') }
    expect(await client.sync()).toMatchObject({ ok: false, error: { kind: 'network' } })
    expect(client.pendingCount()).toBe(1)
    expect(listBullets(db)[0]?.status).toBe('saved_local')

    expect(await client.sync()).toMatchObject({ ok: true, pushed: 1 })
    expect(server.bullets.size).toBe(1)
  })

  test('a lost response is retried safely: the server sees the op once', async () => {
    const { db, server, deps, client } = setup()
    captureBullet(db, { text: 'x' }, deps)
    server.dropNextResponse = true
    expect((await client.sync())?.ok).toBe(false)
    expect(client.pendingCount()).toBe(1)
    expect((await client.sync())?.ok).toBe(true)
    expect(server.received).toHaveLength(1) // the replay was a duplicate
    expect(client.pendingCount()).toBe(0)
  })

  test('a refused op leaves the outbox and is noted on its bullet', async () => {
    const { db, deps, client } = setup()
    const id = captureBullet(db, { text: 'x' }, deps)
    retryBullet(db, id, deps)
    await client.sync()
    expect(client.pendingCount()).toBe(0)
    expect(db.select().from(bullets).get()?.sync_rejection).toBe('invalid: nope')
  })

  test('a malformed op (400) is isolated and dropped; the rest still sync', async () => {
    const { db, server, deps, client } = setup()
    const id = captureBullet(db, { text: 'keep me' }, deps)
    retryBullet(db, id, deps)
    captureBullet(db, { text: 'me too' }, deps)
    server.malformedTypes.add('bullet.retry')
    expect(await client.sync()).toMatchObject({ ok: true })
    expect(client.pendingCount()).toBe(0)
    expect(server.bullets.size).toBe(2)
    expect(
      db
        .select()
        .from(bullets)
        .all()
        .find((b) => b.id === id)?.sync_rejection,
    ).toMatch(/^malformed/)
  })

  test('ops go out in capture order', async () => {
    const { db, server, deps, client } = setup()
    const id = captureBullet(db, { text: 'v1' }, deps)
    editBullet(db, id, 'v2', deps)
    await client.sync()
    expect(server.received.map((o) => o.type)).toEqual(['bullet.create', 'bullet.edit'])
    expect(server.bullets.get(id)?.text).toBe('v2')
  })
})

describe('pull merge', () => {
  test('a local edit still in the outbox is not overwritten by a pull', async () => {
    const { db, server, deps, client } = setup()
    const id = captureBullet(db, { text: 'v1' }, deps)
    await client.sync()
    editBullet(db, id, 'v2 local', deps)
    server.process(id, 'processed')
    // A pull lands before the edit is pushed: the server still has v1.
    applyPull(db, await server.pull({ cursor: getState(db, CURSOR_KEY) }))
    expect(db.select().from(bullets).get()).toMatchObject({
      text: 'v2 local',
      server_status: 'processed',
    })
    expect(listBullets(db)[0]?.status).toBe('saved_local')

    await client.sync()
    expect(db.select().from(bullets).get()?.text).toBe('v2 local')
    expect(listBullets(db)[0]?.status).toBe('synced')
  })

  test('pages until caught up and persists the cursor', async () => {
    const { db, deps, client } = setup({ pullLimit: 2 })
    for (const t of ['a', 'b', 'c', 'd', 'e']) captureBullet(db, { text: t }, deps)
    await client.sync()
    expect(
      db
        .select()
        .from(bullets)
        .all()
        .every((b) => b.server_status === 'synced'),
    ).toBe(true)
    expect(getState(db, CURSOR_KEY)).toBe('5')
  })
})

describe('scheduling', () => {
  test('overlapping syncs coalesce into one run (plus one follow-up)', async () => {
    const { db, server, deps, client } = setup()
    captureBullet(db, { text: 'x' }, deps)
    const a = client.sync()
    const b = client.sync()
    await Promise.all([a, b])
    expect(server.pushCalls).toBe(1)
  })

  test('failures back off exponentially; success resets', async () => {
    const { db, server, deps, client, timers } = setup()
    captureBullet(db, { text: 'x' }, deps)
    server.failNext = { count: 2, error: new TransportError('network', 'offline') }
    client.requestSync()
    await flush()
    await flush()
    expect(timers.map((t) => t.ms)).toEqual([2_000])
    timers[0]?.fn()
    await flush()
    await flush()
    expect(timers.map((t) => t.ms)).toEqual([2_000, 4_000])
    timers[1]?.fn()
    await flush()
    await flush()
    expect(client.pendingCount()).toBe(0)
    expect(timers).toHaveLength(2)
  })

  test('an unauthorized device does not retry in a loop', async () => {
    const { db, server, deps, client, timers } = setup()
    captureBullet(db, { text: 'x' }, deps)
    server.failNext = { count: 1, error: new TransportError('unauthorized', 'bad token', 401) }
    client.requestSync()
    await flush()
    await flush()
    expect(timers).toHaveLength(0)
  })

  test('not paired with a server → no-op', async () => {
    const db = openTestDb()
    const client = createSyncClient({ db, transport: () => null })
    expect(await client.sync()).toBeNull()
  })
})

describe('outcome listener', () => {
  test('hears every run, success or failure, whoever started it', async () => {
    const db = openTestDb()
    const server = new FakeServer()
    const seen: string[] = []
    const client = createSyncClient({
      db,
      transport: () => server,
      onOutcome: (o) => seen.push(o.ok ? 'ok' : o.error.kind),
      setTimer: () => 0,
      clearTimer: () => {},
    })
    captureBullet(db, { text: 'heard' }, testDeps())
    server.failNext = { count: 1, error: new TransportError('network', 'offline') }
    await client.sync()
    client.requestSync()
    await flush()
    await flush()
    expect(seen).toEqual(['network', 'ok'])
  })

  test("a listener that throws doesn't fail the sync", async () => {
    const db = openTestDb()
    const client = createSyncClient({
      db,
      transport: () => new FakeServer(),
      onOutcome: () => {
        throw new Error('listener bug')
      },
    })
    expect(await client.sync()).toMatchObject({ ok: true })
  })
})
