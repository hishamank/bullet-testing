/**
 * Browser edge: where the home server is and this browser's device token, kept in
 * `localStorage` (this origin only). The web client has its own device token, created with the
 * server's `device:add` command; it never shares the phone's.
 */

export interface ServerSettings {
  baseUrl: string
  token: string
}

/** The part of `Storage` this needs (so tests can use a plain object). */
export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const KEY = 'bullet.server'

export interface SettingsStore {
  load(): ServerSettings | null
  save(settings: ServerSettings): void
  clear(): void
}

export function createSettingsStore(storage: KeyValueStorage | null): SettingsStore {
  return {
    load() {
      try {
        const raw = storage?.getItem(KEY)
        if (!raw) return null
        const v = JSON.parse(raw) as Partial<ServerSettings>
        return typeof v.baseUrl === 'string' && typeof v.token === 'string' && v.baseUrl && v.token
          ? { baseUrl: v.baseUrl, token: v.token }
          : null
      } catch {
        return null
      }
    },
    save(settings) {
      storage?.setItem(KEY, JSON.stringify(settings))
    },
    clear() {
      try {
        storage?.removeItem(KEY)
      } catch {
        // Storage blocked: nothing to forget.
      }
    },
  }
}

/** `localStorage`, or null when the browser blocks it. */
export function browserStorage(): KeyValueStorage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}
