/**
 * Persisting the in-browser mirror. The mirror is a cache of the home server (plus the outbox of
 * writes the server has not confirmed yet), kept as one SQLite file image in IndexedDB.
 *
 *  - `BlobStore` is where the image lives: IndexedDB in the browser, memory in tests.
 *  - `createPersister` debounces the saves: every write marks the mirror dirty, one image is
 *    saved a moment later, and `flush()` saves at once (tab hidden, tab closing).
 *  - Writes that queue something for the server are flushed at once (see the runtime), so a
 *    capture is in IndexedDB before "Saved" shows; `flush()` resolves true only when it is stored.
 *  - Saves never overlap. A failed save leaves the mirror dirty and is retried with backoff.
 *  - An image that cannot be opened is copied aside (`backup`) before anything is saved over it.
 */

export interface BlobStore {
  load: () => Promise<Uint8Array | null>
  save: (bytes: Uint8Array) => Promise<void>
  clear: () => Promise<void>
  /** Keep a copy of an image that could not be used, apart from the live one. */
  backup: (bytes: Uint8Array) => Promise<void>
}

export function createMemoryBlobStore(initial: Uint8Array | null = null): BlobStore & {
  readonly saves: number
  readonly backups: Uint8Array[]
} {
  let blob = initial
  let saves = 0
  const backups: Uint8Array[] = []
  return {
    backups,
    backup: async (bytes) => {
      backups.push(bytes.slice())
    },
    get saves() {
      return saves
    },
    load: async () => (blob ? blob.slice() : null),
    save: async (bytes) => {
      blob = bytes.slice()
      saves += 1
    },
    clear: async () => {
      blob = null
    },
  }
}

export interface IdbBlobStoreOptions {
  /** Defaults to the page's `indexedDB`. */
  factory?: IDBFactory
  dbName?: string
  storeName?: string
  key?: string
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
  })
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
  })
}

/** What IndexedDB hands back for a stored Uint8Array, whichever realm it was cloned into. */
function toBytes(value: unknown): Uint8Array | null {
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') {
    return new Uint8Array(value as ArrayBuffer)
  }
  return null
}

export function createIdbBlobStore(opts: IdbBlobStoreOptions = {}): BlobStore {
  const dbName = opts.dbName ?? 'bullet-mirror'
  const storeName = opts.storeName ?? 'files'
  const key = opts.key ?? 'mirror.sqlite'
  let opened: Promise<IDBDatabase> | null = null

  function open(): Promise<IDBDatabase> {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const factory = opts.factory ?? globalThis.indexedDB
      if (!factory) {
        reject(new Error('IndexedDB is not available'))
        return
      }
      const req = factory.open(dbName, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(storeName)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('could not open IndexedDB'))
    })
    // A failed open may be retried on the next call.
    opened.catch(() => {
      opened = null
    })
    return opened
  }

  return {
    async load() {
      const db = await open()
      const value = await request(db.transaction(storeName).objectStore(storeName).get(key))
      return toBytes(value)
    },
    async save(bytes) {
      const db = await open()
      const tx = db.transaction(storeName, 'readwrite')
      tx.objectStore(storeName).put(bytes, key)
      await transactionDone(tx)
    },
    async clear() {
      const db = await open()
      const tx = db.transaction(storeName, 'readwrite')
      tx.objectStore(storeName).delete(key)
      await transactionDone(tx)
    },
    async backup(bytes) {
      const db = await open()
      const tx = db.transaction(storeName, 'readwrite')
      tx.objectStore(storeName).put(bytes, `${key}.backup`)
      await transactionDone(tx)
    },
  }
}

export interface PersisterOptions {
  store: BlobStore
  /** A copy of the database file as it is now. */
  snapshot: () => Uint8Array
  /** Wait this long after the first unsaved write before saving. Default 1500 ms. */
  delayMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  onError?: (err: unknown) => void
}

export interface Persister {
  /** The mirror changed: save it soon. */
  markDirty: () => void
  /** Save now if anything changed since the last save. Resolves true when everything is stored. */
  flush: () => Promise<boolean>
  /** Anything not saved yet? */
  readonly dirty: boolean
  /** Stop the timers without saving (the mirror is being wiped or replaced). */
  dispose: () => void
}

/** Wait before retrying a failed save: 2 s, 4 s, 8 s … at most 30 s. */
export const retryDelay = (failures: number) => Math.min(30_000, 2_000 * 2 ** (failures - 1))

export function createPersister(opts: PersisterOptions): Persister {
  const delayMs = opts.delayMs ?? 1_500
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  let dirty = false
  let timer: unknown = null
  let chain: Promise<unknown> = Promise.resolve()
  let disposed = false
  let failures = 0
  let saving = false

  function stopTimer() {
    if (timer !== null) clearTimer(timer)
    timer = null
  }

  function flush(): Promise<boolean> {
    stopTimer()
    const run = chain.then(async () => {
      if (disposed) return false
      if (!dirty) return true
      dirty = false
      saving = true
      try {
        await opts.store.save(opts.snapshot())
        failures = 0
        return true
      } catch (err) {
        dirty = true
        failures += 1
        opts.onError?.(err)
        if (!disposed && timer === null) {
          timer = setTimer(() => {
            timer = null
            void flush()
          }, retryDelay(failures))
        }
        return false
      } finally {
        saving = false
      }
    })
    chain = run
    return run
  }

  return {
    markDirty() {
      if (disposed) return
      dirty = true
      if (timer === null) {
        timer = setTimer(() => {
          timer = null
          void flush()
        }, delayMs)
      }
    },
    flush,
    get dirty() {
      return dirty || saving
    },
    dispose() {
      disposed = true
      stopTimer()
    },
  }
}
