import { describe, expect, it } from 'vite-plus/test'
import { openTestDb, T0 } from '../../test/db'
import {
  hostOf,
  lastSyncedAt,
  pendingLine,
  recordSynced,
  relativeTime,
  serverRowTitle,
  serverStatusLine,
} from './settings'

const MIN = 60_000

describe('the Home server status line', () => {
  const base = {
    paired: true,
    baseUrl: 'https://my-mac.tailnet.ts.net/bullet',
    reachability: 'ok' as const,
    cannotReach: false,
    lastSyncedAt: T0 - 5 * MIN,
    now: T0,
  }

  it('connected, with the host', () => {
    expect(serverStatusLine(base)).toBe('Connected · my-mac.tailnet.ts.net')
    expect(serverStatusLine({ ...base, baseUrl: 'http://100.64.0.2:3001' })).toBe(
      'Connected · 100.64.0.2:3001',
    )
  })

  it('not paired', () => {
    expect(serverStatusLine({ ...base, paired: false, baseUrl: null })).toBe('Not paired')
  })

  it("can't reach, with when it last synced", () => {
    const down = { ...base, reachability: 'unreachable' as const, cannotReach: true }
    expect(serverStatusLine(down)).toBe("Can't reach · last synced 5 min ago")
    expect(serverStatusLine({ ...down, lastSyncedAt: null })).toBe("Can't reach · not synced yet")
  })

  it('relative times stay short', () => {
    expect(relativeTime(T0 - 10_000, T0)).toBe('just now')
    expect(relativeTime(T0 - 3 * 60 * MIN, T0)).toBe('3 h ago')
    expect(relativeTime(T0 - 30 * 60 * MIN, T0)).toBe('yesterday')
    expect(relativeTime(T0 - 72 * 60 * MIN, T0)).toBe('3 days ago')
    expect(hostOf('not a url')).toBe('not a url')
  })

  it('rows', () => {
    expect(serverRowTitle(false)).toBe('Pair a home server')
    expect(serverRowTitle(true)).toBe('Change server')
    expect(pendingLine(3)).toBe('Pending on this phone · 3')
  })

  it('the last sync is remembered on the phone', () => {
    const db = openTestDb()
    expect(lastSyncedAt(db)).toBeNull()
    recordSynced(db, T0)
    expect(lastSyncedAt(db)).toBe(T0)
  })
})
