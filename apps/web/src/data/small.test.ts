import { describe, expect, test } from 'vite-plus/test'
import { uuidv4 } from './ids'
import { createSettingsStore, type KeyValueStorage } from './settings'
import { acquireMirrorLock, type ChannelLike, type LockManagerLike } from './tab-lock'

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  }
}

describe('server settings', () => {
  test('save, load and clear', () => {
    const storage = memoryStorage()
    const store = createSettingsStore(storage)
    expect(store.load()).toBeNull()
    store.save({ baseUrl: 'http://127.0.0.1:3001', token: 'bjd_made_up' })
    expect(createSettingsStore(storage).load()).toEqual({
      baseUrl: 'http://127.0.0.1:3001',
      token: 'bjd_made_up',
    })
    store.clear()
    expect(store.load()).toBeNull()
    expect(storage.data.size).toBe(0)
  })

  test('a damaged entry reads as not paired', () => {
    const storage = memoryStorage()
    storage.setItem('bullet.server', '{nope')
    expect(createSettingsStore(storage).load()).toBeNull()
    storage.setItem('bullet.server', JSON.stringify({ baseUrl: '', token: 'x' }))
    expect(createSettingsStore(storage).load()).toBeNull()
  })

  test('blocked storage never throws', () => {
    const blocked: KeyValueStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    }
    const store = createSettingsStore(blocked)
    expect(store.load()).toBeNull()
    expect(() => store.clear()).not.toThrow()
    expect(() => createSettingsStore(null).save({ baseUrl: 'a', token: 'b' })).not.toThrow()
  })
})

describe('the one-tab lock', () => {
  /** A Web Locks stand-in: the first request is granted and held, later ones aren't available. */
  function fakeLocks(): LockManagerLike & { granted: number } {
    let held = false
    const locks = {
      granted: 0,
      request(
        _name: string,
        _options: { ifAvailable: true },
        callback: (lock: unknown) => Promise<void>,
      ) {
        if (held) return callback(null)
        held = true
        locks.granted += 1
        return callback({ name: 'bullet-mirror' })
      },
    }
    return locks
  }

  test('the first tab owns the mirror, the second is told to use the first', async () => {
    const locks = fakeLocks()
    expect(await acquireMirrorLock(locks)).toBe('owner')
    expect(await acquireMirrorLock(locks)).toBe('other-tab')
    expect(locks.granted).toBe(1)
  })

  test('without the Web Locks API the tab simply proceeds', async () => {
    expect(await acquireMirrorLock(undefined, 'x', () => null)).toBe('owner')
  })

  test('a failing lock manager does not lock the user out', async () => {
    const broken: LockManagerLike = { request: () => Promise.reject(new Error('nope')) }
    expect(await acquireMirrorLock(broken)).toBe('owner')
  })
})

describe('the one-tab check on plain http (no Web Locks)', () => {
  /** A BroadcastChannel bus: every message reaches every other channel on it. */
  function bus() {
    const channels: ChannelLike[] = []
    return () => {
      const ch: ChannelLike = {
        onmessage: null,
        postMessage: (m) => {
          for (const other of channels) {
            if (other !== ch) queueMicrotask(() => other.onmessage?.({ data: m }))
          }
        },
        close: () => {},
      }
      channels.push(ch)
      return ch
    }
  }

  test('the first tab owns it; a second one hears the owner answer', async () => {
    const make = bus()
    expect(await acquireMirrorLock(undefined, 'x', make, 20)).toBe('owner')
    expect(await acquireMirrorLock(undefined, 'x', make, 200)).toBe('other-tab')
  })
})

describe('ids', () => {
  test('without randomUUID (plain http) ids are still v4 UUIDs', () => {
    const crypto = { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) }
    const a = uuidv4(crypto)
    const b = uuidv4(crypto)
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(a).not.toBe(b)
  })

  test('uses randomUUID when the browser has it', () => {
    expect(
      uuidv4({
        getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
        randomUUID: () => 'x-y' as `${string}-${string}-${string}-${string}-${string}`,
      }),
    ).toBe('x-y')
  })
})
