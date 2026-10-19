/**
 * Browser edge: the app-wide runtime. It owns the in-browser mirror (and saving it), the sync
 * client and its controller, the Inbox controller, and the device's server settings. All the logic
 * is in `@bullet/client` (the same functions the phone calls); this file only wires browser
 * pieces to them: sql.js + IndexedDB for the database, `fetch` for the transport, `localStorage`
 * for the token.
 *
 * The mirror is a cache. `unpair()` and `resetLocalCopy()` wipe it; the next full pull rebuilds it.
 */

import {
  createHttpTransport,
  createInboxController,
  createStore,
  createSyncClient,
  createSyncController,
  type InboxController,
  type LocalDeps,
  type PhoneDb,
  type Store,
  type SyncClient,
  type SyncController,
  type SyncTransport,
} from '@bullet/client'
import type { SqlJsStatic } from 'sql.js'
import { browserTimezone, browserUuid } from '../data/ids'
import { openMirror, type Mirror } from '../data/open'
import { type BlobStore, createPersister, type Persister } from '../data/persist'
import type { ServerSettings, SettingsStore } from '../data/settings'

export interface RuntimeOptions {
  sql: SqlJsStatic
  store: BlobStore
  settings: SettingsStore
  fetch?: typeof fetch
  uuid?: () => string
  timezone?: () => string
  now?: () => number
  /** Whether the tab is visible right now. */
  visible?: () => boolean
  persistDelayMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface Runtime {
  /** The current mirror (a new one after a wipe, so don't hold on to it). */
  db: () => PhoneDb
  deps: LocalDeps
  sync: SyncController
  inbox: InboxController
  /** The last thing worth saying to a screen reader (read into a live region). */
  announcements: Store<string>
  /** True when a saved mirror could not be read and was started again. */
  recoveredMirror: boolean
  /** The `fetch` the app talks to the home server with (pairing check, audio). */
  fetch: typeof fetch
  server: () => ServerSettings | null
  transport: () => SyncTransport | null
  /** Re-run live queries and save the mirror soon (call after a local write). */
  notify: () => void
  /** Run a local write, refresh the screens, and sync. */
  run<T>(write: () => T): T
  /** Save the mirror now (tab hidden or closing). */
  flush: () => Promise<void>
  /** Keep this browser's token and pair with the server. */
  pair: (settings: ServerSettings) => void
  /** Forget the server and wipe the local copy. Unsent captures are lost. */
  unpair: () => Promise<void>
  /** Wipe the local copy; it is rebuilt from a full pull. Unsent captures are lost. */
  resetLocalCopy: () => Promise<void>
  dispose: () => void
}

export async function createRuntime(o: RuntimeOptions): Promise<Runtime> {
  const now = o.now ?? Date.now
  const deps: LocalDeps = {
    now,
    uuid: o.uuid ?? browserUuid,
    timezone: o.timezone ?? browserTimezone,
  }
  const announcements = createStore('')
  const doFetch: typeof fetch = o.fetch ?? ((input, init) => fetch(input, init))

  let mirror: Mirror = await openMirror(o.sql, o.store)
  let persister: Persister = makePersister(mirror)
  let server: ServerSettings | null = o.settings.load()
  let transport: SyncTransport | null = server ? makeTransport(server) : null
  let client: SyncClient = makeClient()

  function makePersister(m: Mirror): Persister {
    return createPersister({
      store: o.store,
      snapshot: () => m.snapshot(),
      delayMs: o.persistDelayMs,
      setTimer: o.setTimer,
      clearTimer: o.clearTimer,
      onError: (err) => console.warn('could not save the local copy', err),
    })
  }

  function makeTransport(s: ServerSettings): SyncTransport {
    return createHttpTransport({
      baseUrl: s.baseUrl,
      token: s.token,
      fetch: doFetch,
    })
  }

  function makeClient(): SyncClient {
    return createSyncClient({
      db: mirror.db,
      transport: () => transport,
      now,
      onOutcome: (outcome) => sync.onOutcome(outcome),
      setTimer: o.setTimer,
      clearTimer: o.clearTimer,
    })
  }

  const notify = () => {
    persister.markDirty()
    sync.bump()
  }

  const sync: SyncController = createSyncController({
    db: () => mirror.db,
    client: () => client,
    now,
    setTimer: o.setTimer,
    clearTimer: o.clearTimer,
    foreground: o.visible ? o.visible() : true,
    notify,
  })
  sync.pairingStore.set(server ? 'paired' : 'unpaired')

  const inbox = createInboxController({
    db: () => mirror.db,
    deps,
    notify,
    syncNow: () => void sync.syncNow(),
    announce: (message) => announcements.set(message),
    now,
    setTimer: o.setTimer,
    clearTimer: o.clearTimer,
  })

  /** Replace the mirror with an empty one (and the sync client that belongs to it). */
  async function wipe(): Promise<void> {
    persister.dispose()
    inbox.undoStore.set([])
    client.dispose()
    mirror.close()
    await o.store.clear()
    mirror = await openMirror(o.sql, o.store)
    persister = makePersister(mirror)
    client = makeClient()
  }

  return {
    db: () => mirror.db,
    deps,
    sync,
    inbox,
    announcements,
    fetch: doFetch,
    recoveredMirror: mirror.recovered,
    server: () => server,
    transport: () => transport,
    notify,
    run(write) {
      const result = write()
      notify()
      void sync.syncNow()
      return result
    },
    flush: () => persister.flush(),
    pair(settings) {
      o.settings.save(settings)
      server = settings
      transport = makeTransport(settings)
      sync.paired()
    },
    async unpair() {
      o.settings.clear()
      server = null
      transport = null
      await wipe()
      sync.unpaired()
    },
    async resetLocalCopy() {
      await wipe()
      notify()
      void sync.syncNow()
    },
    dispose() {
      sync.dispose()
      client.dispose()
      persister.dispose()
    },
  }
}
