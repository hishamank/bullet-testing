import { describe, expect, it } from 'vite-plus/test'
import {
  cannotReachServer,
  dismissUnreachableNote,
  initialMonitor,
  type MonitorOutcome,
  type MonitorState,
  nextSyncDelay,
  POLL,
  recordExternalSuccess,
  recordOutcome,
  resetForNewServer,
  showUnreachableNote,
} from './monitor'

const ok: MonitorOutcome = { ok: true }
const down: MonitorOutcome = { ok: false, error: { kind: 'network', message: 'offline' } }
const refused: MonitorOutcome = { ok: false, error: { kind: 'unauthorized', message: '401' } }

const run = (outcomes: MonitorOutcome[], from: MonitorState = initialMonitor) =>
  outcomes.reduce((s, o, i) => recordOutcome(s, o, 1000 + i), from)

describe('sync monitor', () => {
  it('a single failed sync is not an outage', () => {
    const s = run([ok, down])
    expect(s.reachability).toBe('ok')
    expect(showUnreachableNote(s)).toBe(false)
  })

  it('two failures in a row start an outage and show the note once', () => {
    const s = run([ok, down, down])
    expect(s.reachability).toBe('unreachable')
    expect(showUnreachableNote(s)).toBe(true)
    // More failures (more captures, more retries) don't make it a new outage.
    const later = run([down, down, down], dismissUnreachableNote(s))
    expect(later.outage).toBe(s.outage)
    expect(showUnreachableNote(later)).toBe(false)
  })

  it('a success ends the outage; the next outage shows the note again', () => {
    const first = dismissUnreachableNote(run([down, down]))
    const recovered = run([ok], first)
    expect(recovered.reachability).toBe('ok')
    expect(showUnreachableNote(recovered)).toBe(false)
    const second = run([down, down], recovered)
    expect(second.outage).toBe(first.outage + 1)
    expect(showUnreachableNote(second)).toBe(true)
  })

  it('a refused token is its own state, not an outage', () => {
    const s = run([refused])
    expect(s.reachability).toBe('unauthorized')
    expect(showUnreachableNote(s)).toBe(false)
    expect(nextSyncDelay(s, { outboxCount: 3, awaitingServer: false })).toBeNull()
  })

  it('an op the server refused is not an outage', () => {
    const s = run([ok, { ok: false, error: { kind: 'conflict', message: 'x' } }])
    expect(s.reachability).toBe('ok')
    expect(s.failures).toBe(1)
  })

  it('takes successes it did not run from the last sync time', () => {
    const s = run([down, down])
    expect(recordExternalSuccess(s, 5000).reachability).toBe('ok')
    // A success older than the failure doesn't end the outage.
    expect(recordExternalSuccess(s, 500).reachability).toBe('unreachable')
    expect(recordExternalSuccess(run([ok]), 1000)).toEqual(run([ok]))
  })

  it('re-pairing forgets the old server without re-showing an old note', () => {
    const s = resetForNewServer(run([down, down]))
    expect(s.reachability).toBe('unknown')
    expect(showUnreachableNote(s)).toBe(false)
  })

  it('counts captures as stuck on the phone when offline or the server is out of reach', () => {
    expect(cannotReachServer(initialMonitor, false)).toBe(true)
    expect(cannotReachServer(initialMonitor, true)).toBe(false)
    expect(cannotReachServer(initialMonitor, null)).toBe(false)
    expect(cannotReachServer(run([down, down]), true)).toBe(true)
  })

  it('backs off after failures and polls by what is waiting', () => {
    const idle = { outboxCount: 0, awaitingServer: false }
    expect(nextSyncDelay(run([ok]), idle)).toBe(POLL.idleMs)
    expect(nextSyncDelay(run([ok]), { ...idle, awaitingServer: true })).toBe(POLL.awaitingMs)
    expect(nextSyncDelay(run([ok]), { ...idle, outboxCount: 1 })).toBe(POLL.outboxMs)
    expect(nextSyncDelay(run([down]), idle)).toBe(POLL.failureBaseMs)
    expect(nextSyncDelay(run([down, down]), idle)).toBe(POLL.failureBaseMs * 2)
    expect(nextSyncDelay(run(Array(20).fill(down)), idle)).toBe(POLL.failureMaxMs)
  })
})
