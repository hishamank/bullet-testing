/**
 * Device edge: observes the sync client's outcomes for the screens, keeps pulling while the app
 * is in the foreground, and tells live queries when local data changed.
 *
 *  - `startSyncEngine()` (runtime.ts) owns the triggers: foreground, network back, background
 *    task, local changes. Every outcome, whoever started the sync, reaches the monitor through
 *    `addSyncOutcomeListener`, so nothing here runs syncs just to see how they went.
 *  - While the app is open, the next sync is scheduled after each outcome (pull results soon
 *    while the server is reading, back off while it is out of reach).
 *  - Row writes SQLite reports (change listener) refresh live queries too, coalesced per burst
 *    (live.ts), so writes made without `notifyLocalChange()` still show.
 *
 * The decisions (outage, note, next delay) and the scheduling are the shared
 * `createSyncController` in `@bullet/client`; this file only supplies the phone's edges.
 */

import { AppState } from 'react-native'
import { getDb, onDataChanged } from '../../data/open'
import {
  createCoalescer,
  createSyncController,
  deferSetup,
  isSetupDeferred,
  type Pairing,
} from '@bullet/client'
import {
  addSyncOutcomeListener,
  getSyncClient,
  reloadServerSettings,
  startSyncEngine,
} from '../../sync/runtime'
import { loadServerSettings, type ServerSettings, saveServerSettings } from '../../sync/settings'

export type { Pairing }

/** Row writes SQLite reports, coalesced into one refresh per burst (e.g. a pull page). */
const live = createCoalescer({
  delayMs: 120,
  coveredMs: 250,
  refresh: () => controller.bump(),
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
})

/** Refresh live queries now (call right after a local write). */
export function notifyLocalChange(): void {
  live.refreshed()
  controller.bump()
}

const controller = createSyncController({
  db: getDb,
  client: getSyncClient,
  foreground: AppState.currentState === 'active',
  notify: notifyLocalChange,
})

export const monitorStore = controller.monitorStore
/** Bumped after every local write and every sync: live queries re-run on it. */
export const changeStore = controller.changeStore
export const pairingStore = controller.pairingStore

/** Sync now (after a capture, a retry, coming to the foreground). Safe to call any time. */
export const syncNow = controller.syncNow

/** Save the home server address and token, and start syncing with it. */
export async function pairDevice(settings: ServerSettings): Promise<void> {
  await saveServerSettings(settings)
  await reloadServerSettings()
  controller.paired()
}

/** "Not yet" at setup: go to Capture without a home server, and remember the choice. */
export function deferPairing(): void {
  deferSetup(getDb())
  pairingStore.set('deferred')
}

/** Call once from the root layout. Returns a stop function. */
export function startAppSync(): () => void {
  const stopOutcomes = addSyncOutcomeListener(controller.onOutcome)
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
    controller.setForeground(state === 'active')
  })
  return () => {
    appState.remove()
    controller.dispose()
    stopOutcomes()
    stopLive()
    live.dispose()
    stopRuntime()
  }
}
