/**
 * Device edge: observes the sync client's outcomes for the screens, keeps pulling while the app
 * is in the foreground, and tells live queries when local data changed.
 *
 *  - `startSyncEngine()` (runtime.ts) owns the triggers: foreground, network back, background
 *    task, local changes. Every outcome, whoever started the sync, reaches `monitorStore` through
 *    `addSyncOutcomeListener`, so nothing here runs syncs just to see how they went.
 *  - While the app is open, the next sync is scheduled after each outcome (pull results soon
 *    while the server is reading, back off while it is out of reach).
 *  - Row writes SQLite reports (change listener) refresh live queries too, coalesced per burst
 *    (live.ts), so writes made without `notifyLocalChange()` still show.
 *  - The client is single-flight, so a sync started here joins any sync already running.
 *
 * The decisions (outage, note, next delay) are pure, in monitor.ts.
 */

import { AppState } from 'react-native'
import { getDb, onDataChanged } from '../../data/open'
import {
  captureCounts,
  createCoalescer,
  createStore,
  deferSetup,
  initialMonitor,
  isSetupDeferred,
  nextSyncDelay,
  recordOutcome,
  resetForNewServer,
  type SyncOutcome,
} from '@bullet/client'
import {
  addSyncOutcomeListener,
  getSyncClient,
  reloadServerSettings,
  startSyncEngine,
} from '../../sync/runtime'
import { loadServerSettings, type ServerSettings, saveServerSettings } from '../../sync/settings'

/**
 * `deferred`: the user chose "Not yet" at setup. Capture and the Journal work and captures queue
 * on the phone; sync stays off (no server to talk to) until they pair.
 */
export type Pairing = 'loading' | 'unpaired' | 'deferred' | 'paired'

export const monitorStore = createStore(initialMonitor)
/** Bumped after every local write and every sync: live queries re-run on it. */
export const changeStore = createStore(0)
export const pairingStore = createStore<Pairing>('loading')

let timer: ReturnType<typeof setTimeout> | null = null
let foreground = AppState.currentState === 'active'

const bump = () => changeStore.set((v) => v + 1)

/** Row writes reported by SQLite, coalesced into one refresh per burst (e.g. a pull page). */
const live = createCoalescer({
  delayMs: 120,
  coveredMs: 250,
  refresh: bump,
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
})

/** Refresh live queries now (call right after a local write). */
export function notifyLocalChange(): void {
  live.refreshed()
  bump()
}

function clearTimer() {
  if (timer !== null) clearTimeout(timer)
  timer = null
}

function scheduleNext() {
  clearTimer()
  if (!foreground || pairingStore.get() !== 'paired') return
  const counts = captureCounts(getDb())
  const delay = nextSyncDelay(monitorStore.get(), {
    outboxCount: counts.outbox,
    awaitingServer: counts.awaitingServer,
  })
  if (delay !== null) timer = setTimeout(() => void syncNow(), delay)
}

function onOutcome(outcome: SyncOutcome) {
  const now = Date.now()
  monitorStore.set((s) =>
    recordOutcome(
      s,
      outcome.ok
        ? { ok: true }
        : { ok: false, error: { kind: outcome.error.kind, message: outcome.error.message } },
      now,
    ),
  )
  notifyLocalChange()
  scheduleNext()
}

/** Sync now (after a capture, a retry, coming to the foreground). Safe to call any time. */
export async function syncNow(): Promise<void> {
  clearTimer()
  if (pairingStore.get() !== 'paired') return
  try {
    await getSyncClient().sync()
  } catch {
    // The client turns failures into outcomes; anything else is a bug we don't loop on.
  }
}

/** Save the home server address and token, and start syncing with it. */
export async function pairDevice(settings: ServerSettings): Promise<void> {
  await saveServerSettings(settings)
  await reloadServerSettings()
  monitorStore.set(resetForNewServer)
  pairingStore.set('paired')
  void syncNow()
}

/** "Not yet" at setup: go to Capture without a home server, and remember the choice. */
export function deferPairing(): void {
  deferSetup(getDb())
  pairingStore.set('deferred')
}

/** Call once from the root layout. Returns a stop function. */
export function startAppSync(): () => void {
  const stopOutcomes = addSyncOutcomeListener(onOutcome)
  // Writes nobody announced (another module, a background sync) still reach the screens.
  const stopLive = onDataChanged(() => live.rowChanged())
  const stopRuntime = startSyncEngine()
  void loadServerSettings()
    .catch(() => null)
    .then((s) =>
      pairingStore.set(s ? 'paired' : isSetupDeferred(getDb()) ? 'deferred' : 'unpaired'),
    )
    .then(() => syncNow())

  // The runtime syncs on foreground and network changes; here we only pause the schedule.
  const appState = AppState.addEventListener('change', (state) => {
    foreground = state === 'active'
    if (foreground) notifyLocalChange()
    else clearTimer()
  })
  return () => {
    appState.remove()
    clearTimer()
    stopOutcomes()
    stopLive()
    live.dispose()
    stopRuntime()
  }
}
