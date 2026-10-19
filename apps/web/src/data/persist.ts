/**
 * Persisting the in-browser mirror. The mirror is a cache of the home server (plus the outbox of
 * writes the server has not confirmed yet), kept as one SQLite file image in IndexedDB.
 *
 *  - `BlobStore` is where the image lives: IndexedDB in the browser, memory in tests.
 *  - `createPersister` debounces the saves: every write marks the mirror dirty, one image is
 *    saved a moment later, and `flush()` saves at once (tab hidden, tab closing).
 *  - Saves never overlap, and a failed save leaves the mirror dirty so the next one retries.
 */

export interface BlobStore {
  load: () => Promise<Uint8Array | null>
  save: (bytes: Uint8Array) => Promise<void>
  clear: () => Promise<void>
}

export function createMemoryBlobStore(initial: Uint8Array | null = null): BlobStore & {
  readonly saves: number
} {
  let blob = initial
  let saves = 0
  return {
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
  /** Save now if anything changed since the last save. Resolves when it is stored. */
  flush: () => Promise<void>
  /** Anything not saved yet? */
  readonly dirty: boolean
  /** Stop the timer without saving (the mirror is being wiped or replaced). */
  dispose: () => void
}

export function createPersister(opts: PersisterOptions): Persister {
  const delayMs = opts.delayMs ?? 1_500
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  let dirty = false
  let timer: unknown = null
  let chain: Promise<void> = Promise.resolve()
  let disposed = false

  function stopTimer() {
    if (timer !== null) clearTimer(timer)
    timer = null
  }

  function flush(): Promise<void> {
    stopTimer()
    chain = chain.then(async () => {
      if (!dirty || disposed) return
      dirty = false
      try {
        await opts.store.save(opts.snapshot())
      } catch (err) {
        dirty = true
        opts.onError?.(err)
      }
    })
    return chain
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
      return dirty
    },
    dispose() {
      disposed = true
      stopTimer()
    },
  }
}
