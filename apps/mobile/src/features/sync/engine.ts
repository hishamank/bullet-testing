/**
 * Device edge: drives the existing sync client (`src/sync`) while the app is in the foreground,
 * observes its outcomes for the screens, and tells live queries when local data changed.
 *
 *  - `startSyncEngine()` (runtime.ts) keeps its triggers: foreground, network back, background
 *    task. This module adds a foreground poll (pull results while the app is open, back off while
 *    the server is out of reach) and records every outcome it sees in `monitorStore`.
 *  - The client is single-flight, so a sync started here joins any sync already running.
 *
 * The decisions (outage, note, next delay) are pure, in monitor.ts.
 */

import * as Network from 'expo-network'
import { AppState } from 'react-native'
import { getState } from '../../data/mirror'
import { getDb } from '../../data/open'
import { getSyncClient, reloadServerSettings, startSyncEngine } from '../../sync/runtime'
import { loadServerSettings, type ServerSettings, saveServerSettings } from '../../sync/settings'
import { captureCounts } from '../capture/counts'
import { createStore } from '../store'
import {
  initialMonitor,
  nextSyncDelay,
  recordExternalSuccess,
  recordOutcome,
  resetForNewServer,
} from './monitor'

export type Pairing = 'loading' | 'unpaired' | 'paired'

export const monitorStore = createStore(initialMonitor)
/** Bumped after every local write and every sync: live queries re-run on it. */
export const changeStore = createStore(0)
export const pairingStore = createStore<Pairing>('loading')

let timer: ReturnType<typeof setTimeout> | null = null
let inFlight: Promise<void> | null = null
let again = false
let foreground = AppState.currentState === 'active'

export function notifyLocalChange(): void {
  changeStore.set((v) => v + 1)
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

async function runTracked() {
  const outcome = await getSyncClient().sync()
  if (outcome) {
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
  }
  notifyLocalChange()
}

/** Sync now (after a capture, a retry, coming to the foreground). Safe to call any time. */
export function syncNow(): Promise<void> {
  clearTimer()
  if (pairingStore.get() !== 'paired') return Promise.resolve()
  if (inFlight) {
    again = true
    return inFlight
  }
  inFlight = (async () => {
    try {
      do {
        again = false
        await runTracked()
      } while (again)
    } catch {
      // The client turns failures into outcomes; anything else is a bug we don't loop on.
    } finally {
      inFlight = null
      scheduleNext()
    }
  })()
  return inFlight
}

/** Successes the runtime ran without us (e.g. the background task) end an outage too. */
function absorbLastSync() {
  const last = Number(getState(getDb(), 'last_sync_at'))
  if (Number.isFinite(last) && last > 0) monitorStore.set((s) => recordExternalSuccess(s, last))
}

/** Save the home server address and token, and start syncing with it. */
export async function pairDevice(settings: ServerSettings): Promise<void> {
  await saveServerSettings(settings)
  await reloadServerSettings()
  monitorStore.set(resetForNewServer)
  pairingStore.set('paired')
  void syncNow()
}

/** Call once from the root layout. Returns a stop function. */
export function startAppSync(): () => void {
  const stopRuntime = startSyncEngine()
  void loadServerSettings()
    .then((s) => pairingStore.set(s ? 'paired' : 'unpaired'))
    .catch(() => pairingStore.set('unpaired'))
    .then(() => syncNow())

  const appState = AppState.addEventListener('change', (state) => {
    foreground = state === 'active'
    if (foreground) {
      absorbLastSync()
      notifyLocalChange()
      void syncNow()
    } else {
      clearTimer()
    }
  })
  const network = Network.addNetworkStateListener((state) => {
    if (state.isConnected && state.isInternetReachable !== false) void syncNow()
  })
  return () => {
    appState.remove()
    network.remove()
    clearTimer()
    stopRuntime()
  }
}
