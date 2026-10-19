import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vite-plus/test'
import { captureBullet, deleteBullet, retryBullet } from '../../data/local'
import { bullets, outbox, syncState } from '../../data/schema'
import { keepAsAudioLocal } from '../journal/audio-only'
import { openTestDb, T0, testDeps } from '../../test/db'
import {
  canSend,
  composerMode,
  composerReducer,
  type ComposerEvent,
  initialComposer,
  SAVED_MS,
} from './composer'
import { seedSuggestion } from '../journal/fixtures'
import { captureCounts } from './counts'
import {
  captureNotice,
  FOUND_SHOWN_MS,
  failedText,
  foundText,
  inboxCornerLabel,
  SORTING_TEXT,
  STILL_SORTING_AFTER_MS,
  STILL_SORTING_TEXT,
  journalCornerLabel,
  onPhoneText,
  unpairedText,
  untranscribableText,
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

  it('before pairing: one quiet line that counts what is saved on the phone', () => {
    expect(captureNotice({ ...base, unpaired: true })).toEqual({ kind: 'unpaired', count: 0 })
    expect(captureNotice({ ...base, unpaired: true, onPhoneCount: 2 })).toEqual({
      kind: 'unpaired',
      count: 2,
    })
    expect(unpairedText(0)).toBe("Saved on this phone · Pair a home server when you're ready")
    expect(unpairedText(2)).toBe('2 saved on this phone · Pair to sync')
  })

  it("recordings that can't be transcribed: a line after Retry's, opening the one capture", () => {
    expect(captureNotice({ ...base, failedCount: 1, untranscribableIds: ['v1'] })).toEqual({
      kind: 'failed',
      count: 1,
    })
    expect(captureNotice({ ...base, untranscribableIds: ['v1'] })).toEqual({
      kind: 'untranscribable',
      count: 1,
      bulletId: 'v1',
    })
    expect(
      captureNotice({
        ...base,
        untranscribableIds: ['v1', 'v2'],
        onPhoneCount: 2,
        cannotReachServer: true,
      }),
    ).toEqual({ kind: 'untranscribable', count: 2, bulletId: null })
    expect(untranscribableText(1)).toBe("1 recording couldn't be transcribed")
    expect(untranscribableText(2)).toBe("2 recordings couldn't be transcribed")
  })

  it('processing feedback: quiet static copy for the latest capture', () => {
    const latest = { id: 'c1', status: 'processing' as const, capturedAt: T0, things: 0 }
    expect(captureNotice({ ...base, latest, now: T0 + 2_000 })).toEqual({
      kind: 'sorting',
      slow: false,
      bulletId: 'c1',
    })
    for (const status of ['saved_local', 'synced', 'transcribing'] as const) {
      expect(captureNotice({ ...base, latest: { ...latest, status }, now: T0 })).toMatchObject({
        kind: 'sorting',
      })
    }
    // Over 5 minutes since the capture: still sorting, the capture is safe.
    expect(captureNotice({ ...base, latest, now: T0 + STILL_SORTING_AFTER_MS + 1 })).toMatchObject({
      kind: 'sorting',
      slow: true,
    })
    // Done, with things found: "N things found", opening the capture.
    const done = { ...latest, status: 'needs_review' as const, things: 3 }
    expect(captureNotice({ ...base, latest: done, now: T0 + 60_000 })).toEqual({
      kind: 'found',
      count: 3,
      bulletId: 'c1',
    })
    // Nothing found, an hour later, or failed: no line from it.
    expect(captureNotice({ ...base, latest: { ...done, things: 0 }, now: T0 })).toEqual({
      kind: 'none',
    })
    expect(captureNotice({ ...base, latest: done, now: T0 + FOUND_SHOWN_MS + 1 })).toEqual({
      kind: 'none',
    })
    expect(captureNotice({ ...base, latest: { ...latest, status: 'failed' }, now: T0 })).toEqual({
      kind: 'none',
    })
    // Retry and offline lines come first.
    expect(captureNotice({ ...base, failedCount: 1, latest, now: T0 })).toMatchObject({
      kind: 'failed',
    })
    expect(SORTING_TEXT).toBe('Saved. Sorting this out in the background.')
    expect(STILL_SORTING_TEXT).toBe('Still sorting. Your capture is safe.')
    expect(foundText(1)).toBe('1 thing found')
    expect(foundText(3)).toBe('3 things found')
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
    expect(captureCounts(db)).toMatchObject({
      onPhone: 2,
      failedIds: [],
      untranscribableIds: [],
      awaitingServer: false,
      outbox: 2,
    })

    // The server took both: one failed, one is in its queue.
    db.delete(outbox).run()
    db.update(bullets).set({ server_status: 'failed' }).where(eq(bullets.id, a)).run()
    db.update(bullets).set({ server_status: 'synced' }).where(eq(bullets.id, b)).run()
    expect(captureCounts(db)).toMatchObject({
      onPhone: 0,
      failedIds: [a],
      untranscribableIds: [],
      awaitingServer: true,
      outbox: 0,
    })

    // A recording kept as audio only (it couldn't be transcribed) no longer counts as failed.
    keepAsAudioLocal(db, a)
    expect(captureCounts(db).failedIds).toEqual([])
    db.delete(syncState).run()

    // Retrying puts it back on the phone until sent; it no longer counts as failed.
    retryBullet(db, a, deps)
    expect(captureCounts(db)).toMatchObject({ onPhone: 1, failedIds: [] })
  })

  it("recordings that can't be transcribed are not retried; kept as audio, they leave both", () => {
    const db = openTestDb()
    const deps = testDeps()
    const typed = captureBullet(db, { text: 'one' }, deps)
    const voice = captureBullet(db, { text: 'Voice note, 0:12' }, deps)
    const silent = captureBullet(db, { text: 'Voice note, 0:03' }, deps)
    db.delete(outbox).run()
    db.update(bullets)
      .set({ server_status: 'failed', server_error_code: 'llm_timeout' })
      .where(eq(bullets.id, typed))
      .run()
    db.update(bullets)
      .set({ server_status: 'failed', server_error_code: 'transcription_failed' })
      .where(eq(bullets.id, voice))
      .run()
    db.update(bullets)
      .set({ server_status: 'failed', server_error_code: 'transcription_no_speech' })
      .where(eq(bullets.id, silent))
      .run()
    expect(captureCounts(db)).toMatchObject({
      failedIds: [typed],
      untranscribableIds: [voice, silent],
    })
    keepAsAudioLocal(db, voice)
    keepAsAudioLocal(db, silent)
    expect(captureCounts(db)).toMatchObject({ failedIds: [typed], untranscribableIds: [] })
  })

  it('the latest capture: its shown status and the things found in it', () => {
    const db = openTestDb()
    expect(captureCounts(db).latest).toBeNull()
    captureBullet(db, { text: 'older' }, testDeps({ now: T0 - 60_000 }))
    const c = captureBullet(db, { text: 'Slept 6 hours. Dentist Thursday 3pm' }, testDeps())
    expect(captureCounts(db).latest).toEqual({
      id: c,
      status: 'saved_local',
      capturedAt: T0,
      things: 0,
    })
    db.delete(outbox).run()
    db.update(bullets).set({ server_status: 'needs_review' }).where(eq(bullets.id, c)).run()
    const tracker = seedSuggestion(db, c, { target_kind: 'tracker', payload: { name: 'Sleep' } })
    seedSuggestion(db, c, {
      target_kind: 'tracker_entry',
      payload: { tracker_id: tracker, value: 6 },
    })
    seedSuggestion(db, c, { target_kind: 'event', payload: { title: 'Dentist' } })
    seedSuggestion(db, c, { target_kind: 'task', payload: { title: 'x' }, status: 'rejected' })
    // "Start tracking Sleep?" with its reading is one thing; a dismissed one is not counted.
    expect(captureCounts(db).latest).toMatchObject({ status: 'needs_review', things: 2 })
  })

  it('ignores deleted captures', () => {
    const db = openTestDb()
    const deps = testDeps({ now: T0 })
    const a = captureBullet(db, { text: 'one' }, deps)
    deleteBullet(db, a, 'cascade', deps)
    expect(captureCounts(db).onPhone).toBe(0)
  })
})
