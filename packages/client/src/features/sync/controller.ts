/**
 * What the screens need from sync, runtime-free: the monitor (reachability, outage note), the
 * pairing state, a counter live queries re-run on, whether a sync is running, and the schedule of
 * the next sync while the app is visible. The phone and the web app each build one with their
 * own edges and feed it their triggers (foreground, network back, local writes).
 *
 *  - Every outcome, whoever started the sync, reaches the monitor through `onOutcome`.
 *  - While visible, the next sync is scheduled after each outcome (soon while the server is
 *    reading, gently when idle, backed off while it is out of reach): `nextSyncDelay`.
 *  - The sync client is single-flight, so a sync started here joins any sync already running.
 */

import type { PhoneDb } from '../../data/db'
import { captureCounts } from '../capture/counts'
import { createStore, type Store } from '../store'
import type { SyncClient, SyncOutcome } from '../../sync/client'
import {
  initialMonitor,
  type MonitorState,
  nextSyncDelay,
  recordOutcome,
  resetForNewServer,
} from './monitor'

/**
 * `deferred`: the user chose "Not yet" at setup. Capture and the Journal work and captures queue
 * on the device; sync stays off (no server to talk to) until they pair.
 */
export type Pairing = 'loading' | 'unpaired' | 'deferred' | 'paired'

export interface SyncControllerEnv {
  db: () => PhoneDb
  client: () => SyncClient
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** Whether the app is in the foreground / the tab is visible, at the start. */
  foreground: boolean
  /** Re-run live queries. Defaults to bumping `changeStore`. */
  notify?: () => void
}

export interface SyncController {
  monitorStore: Store<MonitorState>
  /** Bumped after every local write and every sync: live queries re-run on it. */
  changeStore: Store<number>
  pairingStore: Store<Pairing>
  /** True while a sync started by `syncNow` is running. */
  syncingStore: Store<boolean>
  /** Bump `changeStore` (the default `notify`). */
  bump: () => void
  /** Refresh live queries now (call right after a local write). */
  notifyLocalChange: () => void
  /** Feed a sync outcome in (the client's `onOutcome`). */
  onOutcome: (outcome: SyncOutcome) => void
  /** Sync now (after a capture, a retry, coming to the foreground). Safe to call any time. */
  syncNow: () => Promise<void>
  /** The app went to the foreground / the tab became visible, or the reverse. */
  setForeground: (foreground: boolean) => void
  /** Paired with a (new) server: forget what was learned about the old one, and sync. */
  paired: () => void
  /** Unpaired: stop scheduling, forget the server. */
  unpaired: () => void
  dispose: () => void
}

export function createSyncController(env: SyncControllerEnv): SyncController {
  const now = env.now ?? Date.now
  const setTimer = env.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = env.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const monitorStore = createStore(initialMonitor)
  const changeStore = createStore(0)
  const pairingStore = createStore<Pairing>('loading')
  const syncingStore = createStore(false)
  let timer: unknown = null
  let foreground = env.foreground

  const bump = () => changeStore.set((v) => v + 1)
  const notify = env.notify ?? bump

  function stopTimer() {
    if (timer !== null) clearTimer(timer)
    timer = null
  }

  function scheduleNext() {
    stopTimer()
    if (!foreground || pairingStore.get() !== 'paired') return
    const counts = captureCounts(env.db())
    const delay = nextSyncDelay(monitorStore.get(), {
      outboxCount: counts.outbox,
      awaitingServer: counts.awaitingServer,
    })
    if (delay !== null) timer = setTimer(() => void syncNow(), delay)
  }

  function onOutcome(outcome: SyncOutcome) {
    monitorStore.set((s) =>
      recordOutcome(
        s,
        outcome.ok
          ? { ok: true }
          : { ok: false, error: { kind: outcome.error.kind, message: outcome.error.message } },
        now(),
      ),
    )
    notify()
    scheduleNext()
  }

  async function syncNow(): Promise<void> {
    stopTimer()
    if (pairingStore.get() !== 'paired') return
    syncingStore.set(true)
    try {
      await env.client().sync()
    } catch {
      // The client turns failures into outcomes; anything else is a bug we don't loop on.
    } finally {
      syncingStore.set(false)
    }
  }

  return {
    monitorStore,
    changeStore,
    pairingStore,
    syncingStore,
    bump,
    notifyLocalChange: notify,
    onOutcome,
    syncNow,
    setForeground(next) {
      foreground = next
      if (foreground) notify()
      else stopTimer()
    },
    paired() {
      monitorStore.set(resetForNewServer)
      pairingStore.set('paired')
      void syncNow()
    },
    unpaired() {
      stopTimer()
      monitorStore.set(resetForNewServer)
      pairingStore.set('unpaired')
      notify()
    },
    dispose: stopTimer,
  }
}
