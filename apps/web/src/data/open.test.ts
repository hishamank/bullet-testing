import { bullets, captureBullet, type LocalDeps, outbox } from '@bullet/client'
import { describe, expect, test } from 'vite-plus/test'
import { loadSqlForTests } from '../test/sql'
import { openMirror } from './open'
import { createMemoryBlobStore } from './persist'

const deps: LocalDeps = { now: () => 1_000, uuid: () => crypto.randomUUID(), timezone: () => 'UTC' }

describe('the in-browser mirror (sql.js + drizzle + the phone schema)', () => {
  test('a new mirror is migrated and works like the phone database', async () => {
    const sql = await loadSqlForTests()
    const mirror = await openMirror(sql, createMemoryBlobStore())
    expect(mirror.recovered).toBe(false)
    const id = captureBullet(mirror.db, { text: 'a made-up thought' }, deps)
    expect(
      mirror.db
        .select()
        .from(bullets)
        .all()
        .map((b) => b.id),
    ).toEqual([id])
    // The change and its outbox op are written together.
    expect(mirror.db.select().from(outbox).all()).toHaveLength(1)
    mirror.close()
  })

  test('what was saved comes back after a reload', async () => {
    const sql = await loadSqlForTests()
    const store = createMemoryBlobStore()
    const first = await openMirror(sql, store)
    const id = captureBullet(first.db, { text: 'still here tomorrow' }, deps)
    await store.save(first.snapshot())
    first.close()

    const second = await openMirror(sql, store)
    const rows = second.db.select().from(bullets).all()
    expect(rows.map((b) => [b.id, b.text])).toEqual([[id, 'still here tomorrow']])
    expect(second.db.select().from(outbox).all()).toHaveLength(1)
    second.close()
  })

  test('migrating twice is harmless', async () => {
    const sql = await loadSqlForTests()
    const store = createMemoryBlobStore()
    const first = await openMirror(sql, store)
    await store.save(first.snapshot())
    first.close()
    const again = await openMirror(sql, store)
    expect(again.recovered).toBe(false)
    again.close()
  })

  test('a saved image that is not a database is dropped: the mirror is only a cache', async () => {
    const sql = await loadSqlForTests()
    const store = createMemoryBlobStore(new Uint8Array(2048).fill(7))
    const mirror = await openMirror(sql, store)
    expect(mirror.recovered).toBe(true)
    expect(mirror.db.select().from(bullets).all()).toEqual([])
    mirror.close()
  })

  test('a store that cannot be read starts empty', async () => {
    const sql = await loadSqlForTests()
    const store = {
      ...createMemoryBlobStore(),
      load: () => Promise.reject(new Error('blocked')),
    }
    const mirror = await openMirror(sql, store)
    expect(mirror.db.select().from(bullets).all()).toEqual([])
    mirror.close()
  })
})
