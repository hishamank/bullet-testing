import { describe, expect, test, vi } from 'vite-plus/test'
import { createIdbBlobStore, createMemoryBlobStore, createPersister, retryDelay } from './persist'

const bytes = (...n: number[]) => new Uint8Array(n)

describe('memory blob store', () => {
  test('keeps a copy, not the caller’s buffer', async () => {
    const store = createMemoryBlobStore()
    expect(await store.load()).toBeNull()
    const data = bytes(1, 2, 3)
    await store.save(data)
    data[0] = 9
    expect(Array.from((await store.load()) ?? [])).toEqual([1, 2, 3])
    await store.clear()
    expect(await store.load()).toBeNull()
  })
})

describe('IndexedDB blob store (fake IndexedDB)', () => {
  const name = () => `test-${Math.random().toString(36).slice(2)}`

  test('keeps a backup apart from the live image', async () => {
    const store = createIdbBlobStore({ dbName: name() })
    await store.save(bytes(1))
    await store.backup(bytes(9, 9))
    await store.clear()
    expect(await store.load()).toBeNull()
  })

  test('saves, loads and clears the image', async () => {
    const store = createIdbBlobStore({ dbName: name() })
    expect(await store.load()).toBeNull()
    await store.save(bytes(1, 2, 3, 4))
    const loaded = await store.load()
    expect(loaded).toBeInstanceOf(Uint8Array)
    expect(Array.from(loaded ?? [])).toEqual([1, 2, 3, 4])
    await store.save(bytes(7))
    expect(Array.from((await store.load()) ?? [])).toEqual([7])
    await store.clear()
    expect(await store.load()).toBeNull()
  })

  test('a second store on the same database sees what the first saved', async () => {
    const dbName = name()
    await createIdbBlobStore({ dbName }).save(bytes(5, 6))
    expect(Array.from((await createIdbBlobStore({ dbName }).load()) ?? [])).toEqual([5, 6])
  })

  test('says so when IndexedDB is not available', async () => {
    const store = createIdbBlobStore({ factory: undefined, dbName: name() })
    const original = globalThis.indexedDB
    // @ts-expect-error -- simulate a browser that blocks IndexedDB
    globalThis.indexedDB = undefined
    try {
      await expect(store.load()).rejects.toThrow('IndexedDB is not available')
    } finally {
      globalThis.indexedDB = original
    }
  })
})

/** A persister with manual timers over a store that records every save. */
function setup(opts: { fail?: () => boolean } = {}) {
  const store = createMemoryBlobStore()
  const saved: number[][] = []
  const timers: { fn: () => void; ms: number }[] = []
  let n = 0
  const errors: unknown[] = []
  const persister = createPersister({
    store: {
      load: store.load,
      clear: store.clear,
      backup: store.backup,
      save: async (b) => {
        if (opts.fail?.()) throw new Error('disk full')
        saved.push(Array.from(b))
        await store.save(b)
      },
    },
    snapshot: () => bytes(++n),
    delayMs: 1000,
    setTimer: (fn, ms) => {
      const t = { fn, ms }
      timers.push(t)
      return t
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h as (typeof timers)[number])
      if (i >= 0) timers.splice(i, 1)
    },
    onError: (e) => errors.push(e),
  })
  return { persister, saved, timers, errors }
}

describe('persister', () => {
  test('flush says whether everything is stored', async () => {
    const ok = setup()
    ok.persister.markDirty()
    expect(await ok.persister.flush()).toBe(true)
    expect(await ok.persister.flush()).toBe(true)
    const bad = setup({ fail: () => true })
    bad.persister.markDirty()
    expect(await bad.persister.flush()).toBe(false)
  })

  test('a failed save is retried on a timer with growing waits', async () => {
    let failing = true
    const { persister, timers, saved } = setup({ fail: () => failing })
    persister.markDirty()
    await persister.flush()
    expect(timers.at(-1)?.ms).toBe(retryDelay(1))
    timers.at(-1)?.fn()
    await persister.flush()
    expect(retryDelay(2)).toBe(retryDelay(1) * 2)
    expect(retryDelay(20)).toBe(30_000)
    failing = false
    timers.at(-1)?.fn()
    await persister.flush()
    expect(saved).toHaveLength(1)
    expect(persister.dirty).toBe(false)
  })

  test('debounces: many writes, one timer, one save', async () => {
    const { persister, saved, timers } = setup()
    persister.markDirty()
    persister.markDirty()
    persister.markDirty()
    expect(timers).toHaveLength(1)
    expect(timers[0]?.ms).toBe(1000)
    expect(persister.dirty).toBe(true)
    timers[0]?.fn()
    await persister.flush()
    expect(saved).toEqual([[1]])
    expect(persister.dirty).toBe(false)
  })

  test('flush saves at once and cancels the timer (tab hidden or closing)', async () => {
    const { persister, saved, timers } = setup()
    persister.markDirty()
    await persister.flush()
    expect(saved).toHaveLength(1)
    expect(timers).toHaveLength(0)
  })

  test('flush with nothing changed saves nothing', async () => {
    const { persister, saved } = setup()
    await persister.flush()
    expect(saved).toHaveLength(0)
  })

  test('a failed save keeps the mirror dirty and the next one retries', async () => {
    let failing = true
    const { persister, saved, errors } = setup({ fail: () => failing })
    persister.markDirty()
    await persister.flush()
    expect(errors).toHaveLength(1)
    expect(persister.dirty).toBe(true)
    failing = false
    await persister.flush()
    expect(saved).toHaveLength(1)
    expect(persister.dirty).toBe(false)
  })

  test('saves never overlap, and writes made during a save are saved after it', async () => {
    const store = createMemoryBlobStore()
    let release: (() => void) | undefined
    let running = 0
    let maxRunning = 0
    const order: number[] = []
    let n = 0
    const persister = createPersister({
      store: {
        ...store,
        save: async (b) => {
          running += 1
          maxRunning = Math.max(maxRunning, running)
          if (order.length === 0) await new Promise<void>((r) => (release = r))
          order.push(b[0] ?? 0)
          running -= 1
        },
      },
      snapshot: () => bytes(++n),
      setTimer: () => null,
      clearTimer: () => {},
    })
    persister.markDirty()
    const first = persister.flush()
    await vi.waitFor(() => expect(release).toBeDefined())
    persister.markDirty()
    const second = persister.flush()
    release?.()
    await Promise.all([first, second])
    expect(order).toEqual([1, 2])
    expect(maxRunning).toBe(1)
  })

  test('disposed: no more timers and no more saves', async () => {
    const { persister, saved, timers } = setup()
    persister.markDirty()
    persister.dispose()
    expect(timers).toHaveLength(0)
    persister.markDirty()
    await persister.flush()
    expect(saved).toHaveLength(0)
  })
})
