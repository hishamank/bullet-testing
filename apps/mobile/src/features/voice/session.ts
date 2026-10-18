/**
 * One voice recording, from the first tap to Send or Cancel. Pure: the native recorder is behind
 * the `VoiceDriver` interface (see `drivers.ts`) and the clock is injected, so every path —
 * pause, resume, a phone call, the recognizer giving up, the app going to the background — runs
 * in Vitest.
 *
 * The audio is the source of truth. Nothing here ever drops a finished stretch of audio: every
 * file the driver reports is kept until Send joins them or the user confirms Cancel. The live
 * draft is a by-product; when it fails the recording goes on without it.
 */

/** Why capturing stopped without the user tapping Send. */
export type PauseReason =
  /** The user tapped Pause. */
  | 'user'
  /** A phone call, Siri or an alarm took the microphone. */
  | 'interrupted'
  /** The app left the foreground (or Control Center / a system sheet covered it). */
  | 'background'
  /** The recording reached the longest length one voice note can be. */
  | 'limit'
  /** The recorder kept failing to restart. */
  | 'error'

export type VoicePhase = 'starting' | 'recording' | 'paused' | 'finishing' | 'done' | 'cancelled'

export interface VoiceState {
  phase: VoicePhase
  pauseReason: PauseReason | null
  /** Whether the current recorder makes a live draft (false: recording only). */
  liveDraft: boolean
  /** The live draft could not start, so this recording has none (speech recognizer failed). */
  draftUnavailable: boolean
  /** Time captured in finished stretches. */
  recordedMs: number
  /** When the current stretch started; null while not capturing. */
  runningSince: number | null
  /** Draft text of finished stretches, one paragraph each. */
  paragraphs: string[]
  /** Draft text of the current stretch (replaced by each recognizer result). */
  partial: string
  /** Finished audio files, in order. */
  files: string[]
  /** The driver was asked to stop and its `ended` event hasn't arrived yet. */
  awaitingEnd: boolean
}

/** What a driver reports. Each `ended` closes one stretch and carries its file, if any. */
export type DriverEvent =
  | { type: 'started' }
  | { type: 'draft'; text: string }
  | {
      type: 'ended'
      file: string | null
      /**
       * requested: we asked (pause/stop). interrupted: the system took the microphone.
       * recognizer: the recognizer ended on its own (a final result after silence).
       * error: something failed; `error` says what.
       */
      cause: 'requested' | 'interrupted' | 'recognizer' | 'error'
      error?: string
    }

export interface VoiceDriver {
  /** Makes a live draft while recording. */
  readonly liveDraft: boolean
  readonly mimeType: string
  /**
   * `segments`: each start…stop is its own file (pause stops). `single`: one file, paused and
   * resumed natively, ended only by `stop`.
   */
  readonly mode: 'segments' | 'single'
  /** Start (or resume) capturing. Emits `started`, or `ended` with cause `error`. */
  start(): void
  /** Pause capturing. A `segments` driver stops and emits `ended`. */
  pause(): void
  /** Stop for good (Send). Emits `ended` with the file. */
  stop(): void
  /** Throw everything away (Cancel). No events after this. */
  abort(): void
  subscribe(listener: (e: DriverEvent) => void): () => void
}

export interface FinishedRecording {
  files: string[]
  mimeType: string
  /** The live draft as one text (may be empty). */
  draft: string
  liveDraft: boolean
  recordedMs: number
}

export interface VoiceSessionDeps {
  driver: VoiceDriver
  /** A recording-only driver to switch to when the live-draft driver can't start at all. */
  fallback?: () => VoiceDriver
  now: () => number
  /** Longest recording (the server's upload limit, in time). */
  maxMs: number
  /** How long Send waits for the recorder to close its file (default 5 s). */
  endTimeoutMs?: number
}

/** Restarting the recognizer this many times inside `RESTART_WINDOW_MS` means it's broken. */
const MAX_RESTARTS = 3
const RESTART_WINDOW_MS = 10_000

export const initialVoiceState = (liveDraft: boolean): VoiceState => ({
  phase: 'starting',
  pauseReason: null,
  liveDraft,
  draftUnavailable: false,
  recordedMs: 0,
  runningSince: null,
  paragraphs: [],
  partial: '',
  files: [],
  awaitingEnd: false,
})

export function elapsedMs(s: VoiceState, now: number): number {
  return s.recordedMs + (s.runningSince === null ? 0 : Math.max(0, now - s.runningSince))
}

/** The whole live draft so far. */
export function draftText(s: VoiceState): string {
  return [...s.paragraphs, s.partial]
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .join(' ')
}

/** Cancel asks first once more than ~10 seconds were recorded. */
export const CANCEL_CONFIRM_MS = 10_000

export function cancelNeedsConfirm(s: VoiceState, now: number): boolean {
  return elapsedMs(s, now) > CANCEL_CONFIRM_MS
}

export function canResume(s: VoiceState, now: number, maxMs: number): boolean {
  return s.phase === 'paused' && elapsedMs(s, now) < maxMs
}

export interface VoiceSession {
  get: () => VoiceState
  subscribe: (listener: () => void) => () => void
  start: () => void
  pause: (reason?: PauseReason) => void
  resume: () => void
  /** The app's foreground state changed. Leaving the foreground pauses (never loses audio). */
  appActive: (active: boolean) => void
  /** Call on every timer tick: enforces the length limit. */
  tick: () => void
  /** Stop and hand over everything recorded. Null when nothing was recorded. */
  finish: () => Promise<FinishedRecording | null>
  /** Throw the recording away. Returns the files to delete. */
  cancel: () => string[]
}

export function createVoiceSession(deps: VoiceSessionDeps): VoiceSession {
  let driver = deps.driver
  let state = initialVoiceState(driver.liveDraft)
  const listeners = new Set<() => void>()
  let restarts: number[] = []
  let active = true
  let finishWaiters: (() => void)[] = []
  let unsubscribe = driver.subscribe(onDriver)

  function set(next: Partial<VoiceState>) {
    state = { ...state, ...next }
    for (const l of listeners) l()
  }

  /** Close the running stretch's clock. */
  function stopClock(): Partial<VoiceState> {
    return { recordedMs: elapsedMs(state, deps.now()), runningSince: null }
  }

  function commitStretch(file: string | null): Partial<VoiceState> {
    const partial = state.partial.trim()
    return {
      files: file ? [...state.files, file] : state.files,
      paragraphs: partial === '' ? state.paragraphs : [...state.paragraphs, partial],
      partial: '',
    }
  }

  function startDriver() {
    set({ phase: 'starting', pauseReason: null })
    driver.start()
  }

  function switchToFallback(): boolean {
    if (!deps.fallback || state.files.length > 0) return false
    unsubscribe()
    driver.abort()
    driver = deps.fallback()
    unsubscribe = driver.subscribe(onDriver)
    set({ liveDraft: false, draftUnavailable: true, partial: '' })
    startDriver()
    return true
  }

  function onDriver(e: DriverEvent) {
    if (state.phase === 'cancelled' || state.phase === 'done') return
    switch (e.type) {
      case 'started':
        if (state.phase === 'starting') {
          set({ phase: 'recording', runningSince: deps.now() })
        }
        return
      case 'draft':
        if (state.liveDraft) set({ partial: e.text })
        return
      case 'ended':
        return onEnded(e)
    }
  }

  function onEnded(e: Extract<DriverEvent, { type: 'ended' }>) {
    const wasCapturing = state.phase === 'recording' || state.phase === 'starting'
    set({ ...stopClock(), ...commitStretch(e.file), awaitingEnd: false })
    if (state.phase === 'finishing') {
      const waiters = finishWaiters
      finishWaiters = []
      for (const w of waiters) w()
      return
    }
    if (!wasCapturing) return // the end of a stretch we paused ourselves
    if (e.cause === 'interrupted') return set({ phase: 'paused', pauseReason: 'interrupted' })
    if (!active) return set({ phase: 'paused', pauseReason: 'background' })
    // Before any audio exists, a failing live-draft recorder is swapped for a plain one.
    if (e.cause === 'error' && e.file === null && switchToFallback()) return
    // The recognizer ended by itself (or hiccuped): keep recording in a new stretch.
    const now = deps.now()
    restarts = [...restarts.filter((t) => now - t < RESTART_WINDOW_MS), now]
    if (restarts.length > MAX_RESTARTS) return set({ phase: 'paused', pauseReason: 'error' })
    startDriver()
  }

  function pause(reason: PauseReason = 'user') {
    if (state.phase !== 'recording' && state.phase !== 'starting') return
    set({
      ...stopClock(),
      phase: 'paused',
      pauseReason: reason,
      awaitingEnd: driver.mode === 'segments',
    })
    driver.pause()
  }

  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start: () => startDriver(),
    pause,
    resume() {
      if (!canResume(state, deps.now(), deps.maxMs)) return
      restarts = []
      startDriver()
    },
    appActive(next) {
      active = next
      if (!next) pause('background')
    },
    tick() {
      if (state.phase === 'recording' && elapsedMs(state, deps.now()) >= deps.maxMs) pause('limit')
    },
    async finish() {
      if (state.phase === 'done' || state.phase === 'cancelled') return null
      const capturing = state.phase === 'recording' || state.phase === 'starting'
      // A single-file driver only closes its file on stop, even when paused.
      const mustStop = capturing || (driver.mode === 'single' && state.phase !== 'finishing')
      const waitForEnd = mustStop || state.awaitingEnd
      set({ ...stopClock(), phase: 'finishing', awaitingEnd: waitForEnd })
      if (waitForEnd) {
        const ended = new Promise<void>((resolve) => {
          finishWaiters.push(resolve)
          // A recorder that never reports back must not block saving what we already have.
          setTimeout(resolve, deps.endTimeoutMs ?? 5_000)
        })
        if (mustStop) driver.stop()
        await ended
      }
      unsubscribe()
      set({ phase: 'done' })
      if (state.files.length === 0) return null
      return {
        files: state.files,
        mimeType: driver.mimeType,
        draft: draftText(state),
        liveDraft: state.liveDraft,
        recordedMs: state.recordedMs,
      }
    },
    cancel() {
      unsubscribe()
      driver.abort()
      set({ ...stopClock(), phase: 'cancelled' })
      return state.files
    },
  }
}
