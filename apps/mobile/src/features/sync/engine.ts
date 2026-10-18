/**
 * Device edge: observes the sync client's outcomes for the screens, keeps pulling while the app
 * is in the foreground, and tells live queries when local data changed.
 *
 *  - `startSyncEngine()` (runtime.ts) owns the triggers: foreground, network back, background
 *    task, local changes. Every outcome, whoever started the sync, reaches `monitorStore` through
 *    `addSyncOutcomeListener`, so nothing here runs syncs just to see how they went.
 *  - While the app is open, the next sync is scheduled after each outcome (pull results soon
 *    while the server is reading, back off while it is out of reach).
 *  - The client is single-flight, so a sync started here joins any sync already running.
 *
 * The decisions (outage, note, next delay) are pure, in monitor.ts.
 */

import { AppState } from 'react-native'
import { getDb } from '../../data/open'
import type { SyncOutcome } from '../../sync/client'
import {
  addSyncOutcomeListener,
  getSyncClient,
  reloadServerSettings,
  startSyncEngine,
} from '../../sync/runtime'
import { loadServerSettings, type ServerSettings, saveServerSettings } from '../../sync/settings'
import { captureCounts } from '../capture/counts'
import { createStore } from '../store'
import { initialMonitor, nextSyncDelay, recordOutcome, resetForNewServer } from './monitor'

export type Pairing = 'loading' | 'unpaired' | 'paired'

export const monitorStore = createStore(initialMonitor)
/** Bumped after every local write and every sync: live queries re-run on it. */
export const changeStore = createStore(0)
export const pairingStore = createStore<Pairing>('loading')

let timer: ReturnType<typeof setTimeout> | null = null
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

/** Call once from the root layout. Returns a stop function. */
export function startAppSync(): () => void {
  const stopOutcomes = addSyncOutcomeListener(onOutcome)
  const stopRuntime = startSyncEngine()
  void loadServerSettings()
    .then((s) => pairingStore.set(s ? 'paired' : 'unpaired'))
    .catch(() => pairingStore.set('unpaired'))
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
    stopRuntime()
  }
}
