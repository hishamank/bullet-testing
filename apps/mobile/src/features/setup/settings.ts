/**
 * The Settings sheet's "Home server" section (pure): one status line, the pair/change row, and
 * what is still waiting on this phone. The last successful sync is kept in `sync_state` so the
 * status survives a restart.
 */

import type { PhoneDb } from '../../data/db'
import { getState, setState } from '../../data/mirror'
import type { Reachability } from '../sync/monitor'

export const LAST_SYNCED_KEY = 'last_synced_at'
/** Set when the user tapped "Not yet" at setup: Capture works, sync stays off until paired. */
export const SETUP_DEFERRED_KEY = 'setup_deferred'

export function isSetupDeferred(db: PhoneDb): boolean {
  return getState(db, SETUP_DEFERRED_KEY) === '1'
}

export function deferSetup(db: PhoneDb): void {
  setState(db, SETUP_DEFERRED_KEY, '1')
}

export function lastSyncedAt(db: PhoneDb): number | null {
  const v = Number(getState(db, LAST_SYNCED_KEY))
  return Number.isFinite(v) && v > 0 ? v : null
}

export function recordSynced(db: PhoneDb, at: number): void {
  setState(db, LAST_SYNCED_KEY, String(at))
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function relativeTime(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.floor(h / 24)
  return d === 1 ? 'yesterday' : `${d} days ago`
}

/** The server's host as people know it ("my-mac.tailnet.ts.net"); the address itself if odd. */
export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host || baseUrl
  } catch {
    return baseUrl
  }
}

export interface ServerStatusInput {
  paired: boolean
  baseUrl: string | null
  reachability: Reachability
  /** Offline, or the server can't be reached / refused this phone. */
  cannotReach: boolean
  lastSyncedAt: number | null
  now: number
}

/** "Connected · host", "Not paired", or "Can't reach · last synced 5 min ago". */
export function serverStatusLine(i: ServerStatusInput): string {
  if (!i.paired) return 'Not paired'
  if (i.cannotReach) {
    return i.lastSyncedAt === null
      ? "Can't reach · not synced yet"
      : `Can't reach · last synced ${relativeTime(i.lastSyncedAt, i.now)}`
  }
  return i.baseUrl ? `Connected · ${hostOf(i.baseUrl)}` : 'Connected'
}

export const serverRowTitle = (paired: boolean) => (paired ? 'Change server' : 'Pair a home server')

export const pendingLine = (n: number) => `Pending on this phone · ${n}`
