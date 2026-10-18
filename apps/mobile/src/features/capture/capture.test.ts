import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vite-plus/test'
import { captureBullet, deleteBullet, retryBullet } from '../../data/local'
import { bullets, outbox } from '../../data/schema'
import { openTestDb, T0, testDeps } from '../../test/db'
import {
  canSend,
  composerMode,
  composerReducer,
  type ComposerEvent,
  initialComposer,
  SAVED_MS,
} from './composer'
import { captureCounts } from './counts'
import {
  captureNotice,
  failedText,
  inboxCornerLabel,
  journalCornerLabel,
  onPhoneText,
} from './notice'

const play = (events: ComposerEvent[]) => events.reduce(composerReducer, initialComposer)

describe('composer', () => {
  it('is idle, mic first, until the text is tapped', () => {
    expect(composerMode(initialComposer)).toBe('idle')
    expect(composerMode(play([{ type: 'focus' }]))).toBe('typing')
    // A draft keeps the typing layout even with the keyboard down.
    expect(
      composerMode(play([{ type: 'focus' }, { type: 'change', text: 'hi' }, { type: 'blur' }])),
    ).toBe('typing')
  })

  it('shows Saved after a voice note without dropping a typed draft', () => {
    expect(composerMode(play([{ type: 'saved_elsewhere', at: 0 }]))).toBe('saved')
    const typed = play([
      { type: 'change', text: 'half a thought' },
      { type: 'saved_elsewhere', at: 0 },
    ])
    expect(typed.text).toBe('half a thought')
  })

  it('clears the page and shows Saved for about two seconds after Send', () => {
    const sent = play([{ type: 'focus' }, { type: 'change', text: 'hi' }, { type: 'sent', at: 0 }])
    expect(sent.text).toBe('')
    expect(composerMode(sent)).toBe('saved')
    expect(composerMode(composerReducer(sent, { type: 'saved_elapsed', at: SAVED_MS - 1 }))).toBe(
      'saved',
    )
    expect(composerMode(composerReducer(sent, { type: 'saved_elapsed', at: SAVED_MS }))).toBe(
      'idle',
    )
  })

  it("an earlier save's timer doesn't cut a later Saved short", () => {
    const again = play([
      { type: 'sent', at: 0 },
      { type: 'change', text: 'x' },
      { type: 'sent', at: 1500 },
    ])
    expect(composerMode(composerReducer(again, { type: 'saved_elapsed', at: SAVED_MS }))).toBe(
      'saved',
    )
  })

  it('starting to type hides Saved', () => {
    expect(composerMode(play([{ type: 'sent', at: 0 }, { type: 'focus' }]))).toBe('typing')
  })

  it('only sends something', () => {
    expect(canSend('  \n ')).toBe(false)
    expect(canSend(' a ')).toBe(true)
  })
})

describe('capture notice', () => {
  const base = { saved: false, failedCount: 0, onPhoneCount: 0, cannotReachServer: false }

  it('shows one line at a time: saved, then failed, then waiting on the phone', () => {
    expect(captureNotice({ ...base, saved: true, failedCount: 1 })).toEqual({ kind: 'saved' })
    expect(
      captureNotice({ ...base, failedCount: 2, onPhoneCount: 3, cannotReachServer: true }),
    ).toEqual({ kind: 'failed', count: 2 })
    expect(captureNotice({ ...base, onPhoneCount: 3, cannotReachServer: true })).toEqual({
      kind: 'on_phone',
      count: 3,
    })
  })

  it("doesn't mention captures on the phone while they are about to sync", () => {
    expect(captureNotice({ ...base, onPhoneCount: 1 })).toEqual({ kind: 'none' })
  })

  it('uses the approved microcopy', () => {
    expect(onPhoneText(3)).toBe('3 on this phone · will sync')
    expect(failedText(1)).toBe("1 capture couldn't be processed")
    expect(failedText(2)).toBe("2 captures couldn't be processed")
    expect(inboxCornerLabel(3)).toBe('Open inbox, 3 waiting')
    expect(journalCornerLabel(0)).toBe('Open journal')
    expect(journalCornerLabel(1)).toBe('Open journal, 1 capture needs attention')
  })
})

describe('capture counts', () => {
  it('counts unsent captures, failed ones and work waiting on the server', () => {
    const db = openTestDb()
    const deps = testDeps()
    const a = captureBullet(db, { text: 'one' }, deps)
    const b = captureBullet(db, { text: 'two' }, deps)
    expect(captureCounts(db)).toEqual({
      onPhone: 2,
      failedIds: [],
      awaitingServer: false,
      outbox: 2,
    })

    // The server took both: one failed, one is in its queue.
    db.delete(outbox).run()
    db.update(bullets).set({ server_status: 'failed' }).where(eq(bullets.id, a)).run()
    db.update(bullets).set({ server_status: 'synced' }).where(eq(bullets.id, b)).run()
    expect(captureCounts(db)).toEqual({
      onPhone: 0,
      failedIds: [a],
      awaitingServer: true,
      outbox: 0,
    })

    // Retrying puts it back on the phone until sent; it no longer counts as failed.
    retryBullet(db, a, deps)
    expect(captureCounts(db)).toMatchObject({ onPhone: 1, failedIds: [] })
  })

  it('ignores deleted captures', () => {
    const db = openTestDb()
    const deps = testDeps({ now: T0 })
    const a = captureBullet(db, { text: 'one' }, deps)
    deleteBullet(db, a, 'cascade', deps)
    expect(captureCounts(db).onPhone).toBe(0)
  })
})
