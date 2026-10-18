/**
 * The recording screen's hook: permissions, then one `VoiceSession` (session.ts) wired to the
 * device — the recorders, app foreground state, keep-awake, the timer tick and the crash-recovery
 * notes. All decisions live in the pure modules; this only connects them.
 */

import { useAudioRecorder } from 'expo-audio'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { AppState } from 'react-native'
import type { CaptureLinks } from '../../data/local'
import { deviceDeps } from '../../sync/runtime'
import { type VoiceAccess, voiceAccess } from './access'
import {
  discardRecording,
  markSessionLive,
  recoverInterruptedRecordings,
  saveRecording,
} from './actions'
import {
  deviceVoiceIo,
  readVoicePermissions,
  recordingsRoot,
  requestVoicePermissions,
  voiceStoreDeps,
} from './device'
import { AUDIO_RECORDING_OPTIONS, createAudioDriver, createSpeechDriver } from './drivers'
import { sessionDir, writeSessionMeta } from './save'
import {
  cancelNeedsConfirm,
  createVoiceSession,
  draftText,
  initialVoiceState,
  type VoiceSession,
  type VoiceState,
} from './session'
import { bytesPerSecond, VOICE_FORMAT } from './wav'

/** The longest voice note: what fits the server's 200 MB upload limit as 16 kHz WAV (~1h45). */
const MAX_RECORDING_MS = Math.floor(
  ((200 * 1024 * 1024 - 1024) / bytesPerSecond(VOICE_FORMAT)) * 1000,
)

const KEEP_AWAKE_TAG = 'voice-recording'

export type RecorderScreen =
  | { kind: 'checking' }
  /** First run: explain, then the iOS prompts. */
  | { kind: 'ask' }
  /** The microphone is off in Settings. */
  | { kind: 'blocked' }
  | { kind: 'recording'; access: Extract<VoiceAccess, { kind: 'draft' | 'record_only' }> }

const idle = initialVoiceState(false)
const noSession = () => () => {}

export function useVoiceRecorder(links: CaptureLinks) {
  const audioRecorder = useAudioRecorder(AUDIO_RECORDING_OPTIONS)
  const [screen, setScreen] = useState<RecorderScreen>({ kind: 'checking' })
  const [session, setSession] = useState<VoiceSession | null>(null)
  const [saving, setSaving] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const idRef = useRef<string | null>(null)
  const sessionRef = useRef<VoiceSession | null>(null)
  const startedAtRef = useRef(0)
  const linksRef = useRef(links)
  const state: VoiceState = useSyncExternalStore(
    session?.subscribe ?? noSession,
    session?.get ?? (() => idle),
  )

  const begin = useCallback(
    async (access: VoiceAccess) => {
      if (access.kind !== 'draft' && access.kind !== 'record_only') {
        setScreen(access.kind === 'ask' ? { kind: 'ask' } : { kind: 'blocked' })
        return
      }
      // Anything a crash left behind is saved before a new recording starts.
      await recoverInterruptedRecordings()
      const id = deviceDeps.uuid()
      const dir = sessionDir(recordingsRoot(), id)
      deviceVoiceIo.ensureDir(dir)
      const plain = () => createAudioDriver(audioRecorder)
      const s = createVoiceSession({
        driver:
          access.kind === 'draft'
            ? createSpeechDriver(dir, (uri) => deviceVoiceIo.exists(uri))
            : plain(),
        fallback: access.kind === 'draft' ? plain : undefined,
        now: () => Date.now(),
        maxMs: MAX_RECORDING_MS,
      })
      idRef.current = id
      startedAtRef.current = deviceDeps.now()
      markSessionLive(id, true)
      writeSessionMeta(voiceStoreDeps(), {
        id,
        startedAt: startedAtRef.current,
        links: linksRef.current,
        draft: '',
        liveDraft: access.kind === 'draft',
      })
      setScreen({ kind: 'recording', access })
      sessionRef.current = s
      setSession(s)
      s.start()
    },
    [audioRecorder],
  )

  // Check permissions once, and start at once when they're already settled.
  useEffect(() => {
    let alive = true
    readVoicePermissions()
      .then((p) => {
        if (alive) void begin(voiceAccess(p))
      })
      .catch(() => alive && setScreen({ kind: 'blocked' }))
    return () => {
      alive = false
    }
  }, [begin])

  // Foreground only: leaving the app (or a call / Siri covering it) pauses, keeping the audio.
  useEffect(() => {
    if (!session) return
    const sub = AppState.addEventListener('change', (s) => session.appActive(s === 'active'))
    return () => sub.remove()
  }, [session])

  // The timer, and the length limit.
  const running = state.phase === 'recording' || state.phase === 'starting'
  useEffect(() => {
    if (!session || !running) return
    const timer = setInterval(() => {
      setNow(Date.now())
      session.tick()
    }, 250)
    return () => clearInterval(timer)
  }, [session, running])

  // Don't let auto-lock end a long ramble.
  useEffect(() => {
    if (!running) return
    void activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {})
    return () => void deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {})
  }, [running])

  // Keep the crash-recovery note's draft current as each stretch ends.
  const paragraphs = state.paragraphs.length
  useEffect(() => {
    const id = idRef.current
    if (!id || paragraphs === 0) return
    try {
      writeSessionMeta(voiceStoreDeps(), {
        id,
        startedAt: startedAtRef.current,
        links: linksRef.current,
        draft: draftText(session?.get() ?? idle),
        liveDraft: session?.get().liveDraft ?? false,
      })
    } catch {
      // Best effort: the audio files are what matters.
    }
  }, [paragraphs, session])

  // Leaving the screen any other way than Send/Cancel still saves what was recorded. Reads refs
  // and runs on unmount only (the session doesn't exist yet when React re-runs mount effects).
  useEffect(
    () => () => {
      const session = sessionRef.current
      if (!session) return
      const { phase } = session.get()
      const id = idRef.current
      if (!id || phase === 'done' || phase === 'cancelled' || phase === 'finishing') return
      void session
        .finish()
        .then(async (rec) => {
          if (rec) await saveRecording(id, rec, linksRef.current)
          else discardRecording(id, [])
        })
        .catch(() => {
          // The session folder stays on disk: the next recording saves it.
        })
    },
    [],
  )

  const allow = useCallback(async () => {
    try {
      await begin(voiceAccess(await requestVoicePermissions()))
    } catch {
      setScreen({ kind: 'blocked' })
    }
  }, [begin])

  /** Stop and save. Resolves true when something was saved. */
  const send = useCallback(async () => {
    const id = idRef.current
    if (!session || !id || saving) return false
    setSaving(true)
    try {
      const rec = await session.finish()
      if (!rec) {
        discardRecording(id, [])
        return false
      }
      return (await saveRecording(id, rec, linksRef.current)) !== null
    } catch {
      // The session folder stays on disk: the next recording (or app start) saves it.
      return false
    } finally {
      setSaving(false)
    }
  }, [session, saving])

  const cancel = useCallback(() => {
    const id = idRef.current
    if (!session || !id) return
    const files = session.cancel()
    const single = audioRecorder.uri
    discardRecording(id, single && !state.liveDraft ? [...files, single] : files)
  }, [session, audioRecorder, state.liveDraft])

  return {
    screen,
    state,
    now,
    saving,
    maxMs: MAX_RECORDING_MS,
    needsCancelConfirm: cancelNeedsConfirm(state, Date.now()),
    allow,
    pause: () => session?.pause('user'),
    resume: () => session?.resume(),
    send,
    cancel,
  }
}
