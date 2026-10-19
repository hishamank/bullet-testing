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
import {
  lastSyncedAt,
  pendingLine,
  serverRowTitle,
  serverStatusLine,
} from '@/features/setup/settings'
import {
  type EvergreenChoices,
  evergreenChoices,
  loadThinkView,
  type ThinkView,
} from '@/features/reflect/model'
import type { Store } from '@/features/store'
import { changeStore, monitorStore, type Pairing, pairingStore } from '@/features/sync/engine'
import { currentServerSettings } from '@/sync/runtime'
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

export interface ServerStatus {
  paired: boolean
  /** "Connected · host" / "Not paired" / "Can't reach · last synced …". */
  statusLine: string
  /** "Pair a home server" or "Change server". */
  rowTitle: string
  /** "Pending on this phone · N" (ops not yet confirmed by the server). */
  pendingLine: string
}

/** The Settings sheet's Home server section. */
export function useServerStatus(): ServerStatus {
  const paired = usePairing() === 'paired'
  const sync = useSyncStatus()
  const counts = useCaptureCounts()
  const synced = useLocalQuery(lastSyncedAt)
  return {
    paired,
    statusLine: serverStatusLine({
      paired,
      baseUrl: currentServerSettings()?.baseUrl ?? null,
      reachability: sync.reachability,
      cannotReach: sync.cannotReachServer,
      lastSyncedAt: synced,
      now: Date.now(),
    }),
    rowTitle: serverRowTitle(paired),
    pendingLine: pendingLine(counts.outbox),
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

/** The Inbox's "To think about" and "Answered · N" (never part of the badge). */
export function useThinkView(): ThinkView {
  // Re-read every minute too, so a question whose "Later" week ends while open shows up.
  const now = useNow(60_000)
  return useLocalQuery((db) => loadThinkView(db, now), now)
}

/** The "Pick a question" list. */
export function useEvergreenChoices(): EvergreenChoices {
  return useLocalQuery(evergreenChoices)
}

/** The clock, re-read every `everyMs` (for text that changes with time, never an animation). */
export function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(id)
  }, [everyMs])
  return now
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
