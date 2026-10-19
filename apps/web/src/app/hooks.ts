/**
 * The hook layer the screens use. Thin: each hook subscribes to a store from `@bullet/client`'s
 * controllers or re-runs a pure query over the local mirror when local data changes. Same shape as
 * the phone's `hooks/index.ts`.
 */

import {
  buildInbox,
  dismissUnreachableNote,
  cannotReachServer,
  captureCounts,
  type CaptureCounts,
  evergreenChoices,
  type EvergreenChoices,
  inboxCount,
  type InboxView,
  lastSyncedAt,
  loadInboxRows,
  loadLoopAnswers,
  loadNoticed,
  loadRelated,
  loadTheme,
  loadThinkView,
  type LoopAnswerCard,
  type MergeChoice,
  mergeChoices,
  type NoticedCard,
  type Pairing,
  type PhoneDb,
  type Reachability,
  type RelatedItem,
  showUnreachableNote,
  type Store,
  type ThemeView,
  type ThinkView,
} from '@bullet/client'
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'
import { type Indicator, syncIndicator } from './status'
import type { Runtime } from './runtime'

export const RuntimeContext = createContext<Runtime | null>(null)

export function useRuntime(): Runtime {
  const rt = useContext(RuntimeContext)
  if (!rt) throw new Error('RuntimeContext is missing')
  return rt
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

/**
 * A live query over the local mirror: re-runs whenever local data changes (a local write or a
 * sync). `key` re-runs it when the query's own inputs change (e.g. a route param).
 */
export function useLocalQuery<T>(query: (db: PhoneDb) => T, key: unknown = null): T {
  const rt = useRuntime()
  const version = useStore(rt.sync.changeStore)
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- re-run on data changes and `key` only
  return useMemo(() => query(rt.db()), [version, key, rt])
}

export function usePairing(): Pairing {
  return useStore(useRuntime().sync.pairingStore)
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

/** `navigator.onLine`, kept current. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener('online', listener)
      window.addEventListener('offline', listener)
      return () => {
        window.removeEventListener('online', listener)
        window.removeEventListener('offline', listener)
      }
    },
    () => navigator.onLine,
    () => true,
  )
}

/** A CSS media query, kept current. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      const mq = window.matchMedia(query)
      mq.addEventListener('change', listener)
      return () => mq.removeEventListener('change', listener)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}

export function useCaptureCounts(): CaptureCounts {
  return useLocalQuery(captureCounts)
}

export function useInboxCount(): number {
  return useLocalQuery(inboxCount)
}

export interface SyncStatus {
  paired: boolean
  reachability: Reachability
  /** Offline, or the home server can't be reached / refused this browser. */
  cannotReachServer: boolean
  showUnreachableNote: boolean
  dismissUnreachableNote: () => void
  indicator: Indicator
  lastSyncedAt: number | null
}

export function useSyncStatus(): SyncStatus {
  const rt = useRuntime()
  const monitor = useStore(rt.sync.monitorStore)
  const syncing = useStore(rt.sync.syncingStore)
  const paired = usePairing() === 'paired'
  const online = useOnline()
  const counts = useCaptureCounts()
  const synced = useLocalQuery(lastSyncedAt)
  const cannotReach = cannotReachServer(monitor, online)
  return {
    paired,
    reachability: monitor.reachability,
    cannotReachServer: cannotReach,
    showUnreachableNote: showUnreachableNote(monitor),
    dismissUnreachableNote: () => rt.sync.monitorStore.set(dismissUnreachableNote),
    indicator: syncIndicator({
      paired,
      syncing,
      reachability: monitor.reachability,
      cannotReach,
      onDevice: counts.onPhone,
    }),
    lastSyncedAt: synced,
  }
}

/** The Inbox view: the live local query plus the open Undo windows. */
export function useInbox(): InboxView {
  const rt = useRuntime()
  const undo = useStore(rt.inbox.undoStore)
  // Re-read every minute too: a question back from "Later" makes the Inbox no longer empty.
  const now = useNow(60_000)
  const heldIds = undo.map((e) => e.suggestionId)
  const key = `${heldIds.join(',')}|${now}`
  const rows = useLocalQuery(
    (db) => loadInboxRows(db, { now, timezone: rt.deps.timezone(), heldIds }),
    key,
  )
  return useMemo(() => buildInbox(rows, undo), [rows, undo])
}

/** The Inbox's "To think about" and "Answered · N" (never part of the badge). */
export function useThinkView(): ThinkView {
  const now = useNow(60_000)
  return useLocalQuery((db) => loadThinkView(db, now), now)
}

/** The Inbox's Noticed cards, newest first. */
export function useNoticed(): NoticedCard[] {
  const now = useNow(60_000)
  return useLocalQuery((db) => loadNoticed(db, now), now)
}

/** "Did this close it?" cards waiting (these do count in the badge). */
export function useLoopAnswers(): LoopAnswerCard[] {
  const rt = useRuntime()
  const undo = useStore(rt.inbox.undoStore)
  const held = useMemo(() => new Map(undo.map((e) => [e.suggestionId, e.decision])), [undo])
  return useLocalQuery((db) => loadLoopAnswers(db, held), held)
}

export function useMergeChoices(themeId: string | null): MergeChoice[] {
  return useLocalQuery((db) => (themeId ? mergeChoices(db, themeId) : []), themeId)
}

export function useRelated(bulletId: string): RelatedItem[] {
  const rt = useRuntime()
  return useLocalQuery((db) => loadRelated(db, bulletId, Date.now(), rt.deps.timezone()), bulletId)
}

export function useThemeView(themeId: string): ThemeView | null {
  return useLocalQuery((db) => loadTheme(db, themeId, Date.now()), themeId)
}

export function useEvergreenChoices(): EvergreenChoices {
  return useLocalQuery(evergreenChoices)
}
