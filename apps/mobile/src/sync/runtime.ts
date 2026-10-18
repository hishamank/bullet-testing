/**
 * Device edge: the app-wide sync engine and what triggers it.
 *
 *  - app comes to the foreground → sync
 *  - the network comes back       → sync
 *  - after every local change      → sync (call `syncSoon()`)
 *  - iOS background task           → best-effort sync when the OS allows (often overnight);
 *                                    never relied upon.
 *
 * All the logic is in client.ts; this file only wires React Native / Expo events to it.
 */

import * as BackgroundTask from 'expo-background-task'
import { randomUUID } from 'expo-crypto'
import { File } from 'expo-file-system'
import * as Network from 'expo-network'
import * as TaskManager from 'expo-task-manager'
import { AppState } from 'react-native'
import type { LocalDeps } from '../data/local'
import { getDb } from '../data/open'
import { createSyncClient, type SyncClient } from './client'
import { loadServerSettings, type ServerSettings } from './settings'
import { createHttpTransport, type SyncTransport } from './transport'

const BACKGROUND_TASK = 'bullet-background-sync'

let settings: ServerSettings | null = null
let transport: SyncTransport | null = null
let client: SyncClient | null = null

/** Clock, ids and time zone for local writes on this device. */
export const deviceDeps: LocalDeps = {
  now: () => Date.now(),
  uuid: () => randomUUID(),
  timezone: () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
}

/** Read part of a recording file (for resumable uploads). */
async function readAudioChunk(localPath: string, offset: number, length: number) {
  const handle = new File(localPath).open()
  try {
    handle.offset = offset
    return handle.readBytes(length)
  } finally {
    handle.close()
  }
}

export function getSyncClient(): SyncClient {
  client ??= createSyncClient({ db: getDb(), transport: () => transport, readAudioChunk })
  return client
}

/** Re-read the server URL/token (after pairing) and sync. */
export async function reloadServerSettings(): Promise<void> {
  settings = await loadServerSettings()
  transport = settings ? createHttpTransport(settings) : null
  getSyncClient().requestSync()
}

/** Ask for a sync now; safe to call after every local change. */
export function syncSoon(): void {
  getSyncClient().requestSync()
}

// Background tasks must be defined at module scope, before the app registers them.
TaskManager.defineTask(BACKGROUND_TASK, async () => {
  try {
    if (!transport) await reloadServerSettings()
    const outcome = await getSyncClient().sync()
    return outcome?.ok === false
      ? BackgroundTask.BackgroundTaskResult.Failed
      : BackgroundTask.BackgroundTaskResult.Success
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed
  }
})

/** Start listening for triggers. Returns a stop function. Call once from the root layout. */
export function startSyncEngine(): () => void {
  void reloadServerSettings()
  const appState = AppState.addEventListener('change', (state) => {
    if (state === 'active') syncSoon()
  })
  const network = Network.addNetworkStateListener((state) => {
    if (state.isConnected && state.isInternetReachable !== false) syncSoon()
  })
  BackgroundTask.registerTaskAsync(BACKGROUND_TASK, { minimumInterval: 15 }).catch(() => {
    // Best effort: unavailable in Expo Go, the simulator, or when the user disabled it.
  })
  return () => {
    appState.remove()
    network.remove()
    client?.dispose()
    client = null
  }
}
