import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'
import {
  cancelNeedsConfirm,
  createVoiceSession,
  type DriverEvent,
  draftText,
  elapsedMs,
  type VoiceDriver,
  type VoiceSessionDeps,
} from './session'

/** A scripted recorder: records what it was asked, and lets the test emit its events. */
class FakeDriver implements VoiceDriver {
  calls: string[] = []
  private listener: ((e: DriverEvent) => void) | null = null
  private n = 0
  constructor(
    readonly mode: 'segments' | 'single' = 'segments',
    readonly liveDraft = mode === 'segments',
    readonly mimeType = mode === 'segments' ? 'audio/wav' : 'audio/mp4',
  ) {}
  start() {
    this.calls.push('start')
  }
  pause() {
    this.calls.push('pause')
  }
  stop() {
    this.calls.push('stop')
  }
  abort() {
    this.calls.push('abort')
  }
  subscribe(l: (e: DriverEvent) => void) {
    this.listener = l
    return () => {
      this.listener = null
    }
  }
  emit(e: DriverEvent) {
    this.listener?.(e)
  }
  started() {
    this.emit({ type: 'started' })
  }
  ended(cause: Extract<DriverEvent, { type: 'ended' }>['cause'] = 'requested', file = true) {
    this.emit({ type: 'ended', cause, file: file ? `seg-${++this.n}.wav` : null })
  }
}

let clock = 0
beforeEach(() => {
  clock = 1_000
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

function setup(driver = new FakeDriver(), over: Partial<VoiceSessionDeps> = {}) {
  const s = createVoiceSession({ driver, now: () => clock, maxMs: 60_000, ...over })
  s.start()
  driver.started()
  return { s, driver }
}

describe('recording', () => {
  test('timer counts only time spent recording, across pause and resume', () => {
    const { s, driver } = setup()
    clock += 4_000
    expect(elapsedMs(s.get(), clock)).toBe(4_000)
    s.pause()
    driver.ended()
    clock += 30_000 // paused: doesn't count
    expect(elapsedMs(s.get(), clock)).toBe(4_000)
    s.resume()
    driver.started()
    clock += 2_500
    expect(elapsedMs(s.get(), clock)).toBe(6_500)
    expect(s.get()).toMatchObject({ phase: 'recording', files: ['seg-1.wav'] })
  })

  test('the live draft accumulates one paragraph per stretch', () => {
    const { s, driver } = setup()
    driver.emit({ type: 'draft', text: 'okay so first' })
    driver.emit({ type: 'draft', text: 'okay so first, the talk with Sami' })
    s.pause()
    driver.ended()
    s.resume()
    driver.started()
    driver.emit({ type: 'draft', text: 'dentist Thursday' })
    expect(s.get().paragraphs).toEqual(['okay so first, the talk with Sami'])
    expect(draftText(s.get())).toBe('okay so first, the talk with Sami dentist Thursday')
  })

  test('Send stops, waits for the last file, and hands over everything', async () => {
    const { s, driver } = setup()
    driver.emit({ type: 'draft', text: 'call the bank' })
    clock += 3_000
    const done = s.finish()
    expect(driver.calls).toEqual(['start', 'stop'])
    expect(s.get().phase).toBe('finishing')
    driver.ended()
    await expect(done).resolves.toEqual({
      files: ['seg-1.wav'],
      mimeType: 'audio/wav',
      draft: 'call the bank',
      liveDraft: true,
      recordedMs: 3_000,
    })
    expect(s.get().phase).toBe('done')
  })

  test('Send while paused waits for the pause to close its file', async () => {
    const { s, driver } = setup()
    s.pause()
    const done = s.finish()
    expect(driver.calls).toEqual(['start', 'pause']) // no second stop
    driver.ended()
    await expect(done).resolves.toMatchObject({ files: ['seg-1.wav'] })
  })

  test('a recorder that never reports back does not block saving what exists', async () => {
    const { s, driver } = setup()
    s.pause()
    driver.ended()
    s.resume()
    driver.started()
    const done = s.finish()
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(done).resolves.toMatchObject({ files: ['seg-1.wav'] })
  })

  test('nothing recorded → null', async () => {
    const { s, driver } = setup()
    const done = s.finish()
    driver.ended('requested', false)
    await expect(done).resolves.toBeNull()
  })

  test('a single-file recorder pauses natively and is stopped on Send even when paused', async () => {
    const driver = new FakeDriver('single')
    const { s } = setup(driver)
    s.pause()
    expect(s.get().awaitingEnd).toBe(false)
    s.resume()
    driver.started()
    s.pause()
    const done = s.finish()
    expect(driver.calls).toEqual(['start', 'pause', 'start', 'pause', 'stop'])
    driver.ended()
    await expect(done).resolves.toMatchObject({
      files: ['seg-1.wav'],
      mimeType: 'audio/mp4',
      liveDraft: false,
    })
  })
})

describe('interruptions never lose audio', () => {
  test('a phone call or Siri pauses and keeps the stretch so far', () => {
    const { s, driver } = setup()
    driver.emit({ type: 'draft', text: 'before the call' })
    clock += 5_000
    driver.ended('interrupted')
    expect(s.get()).toMatchObject({
      phase: 'paused',
      pauseReason: 'interrupted',
      files: ['seg-1.wav'],
      paragraphs: ['before the call'],
    })
    expect(elapsedMs(s.get(), clock + 60_000)).toBe(5_000)
  })

  test('leaving the app pauses; coming back does not resume by itself', () => {
    const { s, driver } = setup()
    s.appActive(false)
    expect(s.get()).toMatchObject({ phase: 'paused', pauseReason: 'background' })
    expect(driver.calls).toEqual(['start', 'pause'])
    driver.ended('interrupted')
    expect(s.get().pauseReason).toBe('background')
    s.appActive(true)
    expect(s.get().phase).toBe('paused')
  })

  test('the recognizer ending by itself starts a new stretch at once', () => {
    const { s, driver } = setup()
    driver.ended('recognizer')
    expect(s.get().phase).toBe('starting')
    expect(driver.calls).toEqual(['start', 'start'])
    driver.started()
    expect(s.get()).toMatchObject({ phase: 'recording', files: ['seg-1.wav'] })
  })

  test('a recognizer that keeps failing pauses instead of looping', () => {
    const { s, driver } = setup()
    for (let i = 0; i < 4; i++) {
      driver.ended('error')
      driver.started()
    }
    expect(s.get()).toMatchObject({ phase: 'paused', pauseReason: 'error' })
    expect(s.get().files).toHaveLength(4)
  })

  test('if the live draft cannot start at all, it records without one', () => {
    const plain = new FakeDriver('single')
    const draft = new FakeDriver('segments')
    const s = createVoiceSession({
      driver: draft,
      fallback: () => plain,
      now: () => clock,
      maxMs: 60_000,
    })
    s.start()
    draft.emit({ type: 'ended', cause: 'error', file: null, error: 'language-not-supported' })
    expect(draft.calls).toEqual(['start', 'abort'])
    expect(plain.calls).toEqual(['start'])
    plain.started()
    expect(s.get()).toMatchObject({ phase: 'recording', liveDraft: false, draftUnavailable: true })
  })

  test('at the length limit it pauses and cannot resume', () => {
    const { s, driver } = setup()
    clock += 60_000
    s.tick()
    expect(s.get()).toMatchObject({ phase: 'paused', pauseReason: 'limit' })
    s.resume()
    expect(driver.calls).toEqual(['start', 'pause'])
  })
})

describe('cancel', () => {
  test('asks first after ~10 seconds', () => {
    const { s } = setup()
    clock += 10_000
    expect(cancelNeedsConfirm(s.get(), clock)).toBe(false)
    clock += 1
    expect(cancelNeedsConfirm(s.get(), clock)).toBe(true)
  })

  test('aborts the recorder, returns the files to delete, ignores late events', () => {
    const { s, driver } = setup()
    s.pause()
    driver.ended()
    s.resume()
    driver.started()
    expect(s.cancel()).toEqual(['seg-1.wav'])
    expect(driver.calls.at(-1)).toBe('abort')
    driver.ended()
    expect(s.get()).toMatchObject({ phase: 'cancelled', files: ['seg-1.wav'] })
  })
})
