/**
 * The hook layer the screens use. Thin: each hook subscribes to a store from `features/` or
 * re-runs a pure query over the local mirror when local data changes.
 */

import * as Network from 'expo-network'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { AccessibilityInfo } from 'react-native'
import type { PhoneDb } from '@/data/db'
import { getDb } from '@/data/open'
import { type CaptureCounts, captureCounts, inboxCount } from '@/features/capture/counts'
import type { Store } from '@/features/store'
import { changeStore, monitorStore, type Pairing, pairingStore } from '@/features/sync/engine'
import {
  cannotReachServer,
  dismissUnreachableNote,
  type Reachability,
  showUnreachableNote,
} from '@/features/sync/monitor'

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

/**
 * A live query over the local mirror: re-runs whenever local data changes (a local write or a
 * sync). `key` re-runs it when the query's own inputs change (e.g. a route param).
 */
export function useLocalQuery<T>(query: (db: PhoneDb) => T, key: unknown = null): T {
  const version = useStore(changeStore)
  return useMemo(() => query(getDb()), [version, key])
}

export function usePairing(): Pairing {
  return useStore(pairingStore)
}

/** True/false when known; null while the OS hasn't said yet. */
export function useOnline(): boolean | null {
  const state = Network.useNetworkState()
  if (state.isConnected === undefined) return null
  return state.isConnected && state.isInternetReachable !== false
}

export interface SyncStatus {
  reachability: Reachability
  /** Offline, or the home server can't be reached / refused this phone. */
  cannotReachServer: boolean
  /** The one-time "Home server unreachable" note for the current outage. */
  showUnreachableNote: boolean
  dismissUnreachableNote: () => void
  lastError: string | null
}

export function useSyncStatus(): SyncStatus {
  const s = useStore(monitorStore)
  const online = useOnline()
  return {
    reachability: s.reachability,
    cannotReachServer: cannotReachServer(s, online),
    showUnreachableNote: showUnreachableNote(s),
    dismissUnreachableNote: () => monitorStore.set(dismissUnreachableNote),
    lastError: s.lastError?.message ?? null,
  }
}

export function useCaptureCounts(): CaptureCounts {
  return useLocalQuery(captureCounts)
}

/** Ops waiting to be sent. */
export function useOutboxCount(): number {
  return useCaptureCounts().outbox
}

export function useInboxCount(): number {
  return useLocalQuery(inboxCount)
}

export function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false)
  useEffect(() => {
    let live = true
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => live && setReduce(v))
      .catch(() => {})
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce)
    return () => {
      live = false
      sub.remove()
    }
  }, [])
  return reduce
}
