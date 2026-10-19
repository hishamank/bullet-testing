/**
 * What the screens need to know about sync, derived from sync outcomes: is the home server
 * reachable, should the one-time "Home server unreachable" note show, and when to sync next.
 *
 * Pure: the device edge (apps/mobile/src/features/sync/engine.ts) feeds it outcomes and the clock.
 *
 * An outage starts after `OUTAGE_AFTER_FAILURES` failed syncs in a row (one blip is not an
 * outage) and ends with the next successful sync. The note shows once per outage: dismissing it,
 * or the outage ending, hides it until the next outage.
 */

import type { TransportErrorKind } from '../../sync/transport'

export type Reachability = 'unknown' | 'ok' | 'unreachable' | 'unauthorized'

export interface MonitorState {
  reachability: Reachability
  lastOkAt: number | null
  lastError: { kind: TransportErrorKind; message: string; at: number } | null
  /** Consecutive failed syncs (any kind). */
  failures: number
  /** Increments each time an outage starts. */
  outage: number
  /** The outage whose note the user has already dismissed. */
  noteDismissedFor: number
}

export type MonitorOutcome =
  | { ok: true }
  | { ok: false; error: { kind: TransportErrorKind; message: string } }

export const OUTAGE_AFTER_FAILURES = 2

export const initialMonitor: MonitorState = {
  reachability: 'unknown',
  lastOkAt: null,
  lastError: null,
  failures: 0,
  outage: 0,
  noteDismissedFor: 0,
}

/** Kinds that mean "the server can't be reached right now" rather than "it refused one thing". */
const OUTAGE_KINDS: ReadonlySet<TransportErrorKind> = new Set(['network', 'server'])

export function recordOutcome(s: MonitorState, outcome: MonitorOutcome, now: number): MonitorState {
  if (outcome.ok) {
    return { ...s, reachability: 'ok', lastOkAt: now, lastError: null, failures: 0 }
  }
  const { kind, message } = outcome.error
  const failures = s.failures + 1
  const lastError = { kind, message, at: now }
  if (kind === 'unauthorized') return { ...s, reachability: 'unauthorized', lastError, failures }
  if (!OUTAGE_KINDS.has(kind)) return { ...s, lastError, failures }
  if (s.reachability === 'unreachable') return { ...s, lastError, failures }
  if (failures < OUTAGE_AFTER_FAILURES) return { ...s, lastError, failures }
  return { ...s, reachability: 'unreachable', lastError, failures, outage: s.outage + 1 }
}

/** The device was (re-)paired: forget everything learned about the old server. */
export function resetForNewServer(s: MonitorState): MonitorState {
  return { ...initialMonitor, outage: s.outage, noteDismissedFor: s.outage }
}

export function dismissUnreachableNote(s: MonitorState): MonitorState {
  return { ...s, noteDismissedFor: s.outage }
}

export function showUnreachableNote(s: MonitorState): boolean {
  return s.reachability === 'unreachable' && s.noteDismissedFor !== s.outage
}

/** Captures waiting on the phone count as "offline" when either is true. */
export function cannotReachServer(s: MonitorState, online: boolean | null): boolean {
  return online === false || s.reachability === 'unreachable' || s.reachability === 'unauthorized'
}

export const POLL = {
  /** Something is waiting on the server (in the queue or being read): check back soon. */
  awaitingMs: 10_000,
  /** Nothing in flight: pull now and then so other devices' changes arrive. */
  idleMs: 60_000,
  /** Ops still in the outbox after a successful sync (queued mid-run). */
  outboxMs: 3_000,
  failureBaseMs: 5_000,
  failureMaxMs: 2 * 60_000,
} as const

/**
 * Delay before the next sync while the app is in the foreground, or null to wait for a trigger
 * (the token was refused: syncing again can't help until the device is re-paired).
 */
export function nextSyncDelay(
  s: MonitorState,
  work: { outboxCount: number; awaitingServer: boolean },
): number | null {
  if (s.reachability === 'unauthorized') return null
  if (s.failures > 0) {
    return Math.min(POLL.failureMaxMs, POLL.failureBaseMs * 2 ** (s.failures - 1))
  }
  if (work.outboxCount > 0) return POLL.outboxMs
  return work.awaitingServer ? POLL.awaitingMs : POLL.idleMs
}
