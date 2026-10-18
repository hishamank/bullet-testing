/**
 * Device edge: the two recorders behind `VoiceDriver` (see session.ts for the logic).
 *
 *  - speech: expo-speech-recognition. One AVAudioEngine microphone tap feeds Apple's on-device
 *    recognizer (English, `requiresOnDeviceRecognition`: nothing leaves the phone) AND writes the
 *    audio to a WAV file (16 kHz mono 16-bit). Each start…stop is one segment file.
 *  - audio: expo-audio (AVAudioRecorder, AAC .m4a). No live draft. Used when speech recognition
 *    is denied or unavailable; paused and resumed natively in one file.
 */

import {
  type AudioRecorder,
  RecordingPresets,
  type RecordingOptions,
  setAudioModeAsync,
} from 'expo-audio'
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition'
import { segmentName } from './save'
import type { DriverEvent, VoiceDriver } from './session'
import { VOICE_FORMAT } from './wav'

type Listener = (e: DriverEvent) => void

/** Errors that only mean "nothing was heard": the recording itself is fine. */
const BENIGN_ERRORS = new Set(['no-speech', 'speech-timeout', 'aborted'])

/** `dir` is the session folder's uri; `exists` tells whether a segment file was written. */
export function createSpeechDriver(dir: string, exists: (uri: string) => boolean): VoiceDriver {
  let listener: Listener | null = null
  let segment = 0
  let requested = false
  let lastError: string | null = null
  let subs: { remove: () => void }[] = []
  const emit = (e: DriverEvent) => listener?.(e)
  const current = () => `${dir}${segmentName(segment)}`

  function attach() {
    const m = ExpoSpeechRecognitionModule
    subs = [
      m.addListener('start', () => emit({ type: 'started' })),
      m.addListener('result', (e) => {
        const text = e.results[0]?.transcript
        if (text !== undefined) emit({ type: 'draft', text })
      }),
      m.addListener('error', (e) => {
        lastError = e.error
      }),
      m.addListener('end', () => {
        const file = segment > 0 && exists(current()) ? current() : null
        const error = lastError
        const cause = requested
          ? 'requested'
          : error === 'interrupted'
            ? 'interrupted'
            : error && !BENIGN_ERRORS.has(error)
              ? 'error'
              : 'recognizer'
        emit({ type: 'ended', file, cause, ...(error ? { error } : {}) })
      }),
    ]
  }

  return {
    liveDraft: true,
    mimeType: 'audio/wav',
    mode: 'segments',
    start() {
      segment += 1
      requested = false
      lastError = null
      ExpoSpeechRecognitionModule.start({
        lang: 'en-US',
        interimResults: true,
        continuous: true,
        requiresOnDeviceRecognition: true,
        addsPunctuation: true,
        iosTaskHint: 'dictation',
        recordingOptions: {
          persist: true,
          outputDirectory: dir,
          outputFileName: segmentName(segment),
          outputSampleRate: VOICE_FORMAT.sampleRate,
          outputEncoding: 'pcmFormatInt16',
        },
      })
    },
    pause() {
      requested = true
      ExpoSpeechRecognitionModule.stop()
    },
    stop() {
      requested = true
      ExpoSpeechRecognitionModule.stop()
    },
    abort() {
      listener = null
      ExpoSpeechRecognitionModule.abort()
    },
    subscribe(l) {
      listener = l
      attach()
      return () => {
        listener = null
        for (const s of subs) s.remove()
        subs = []
      }
    },
  }
}

/** Mono AAC: small enough to keep forever, plenty for speech. Kept in documents, not the cache. */
export const AUDIO_RECORDING_OPTIONS: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  numberOfChannels: 1,
  bitRate: 64_000,
  directory: 'document',
}

/** `recorder` comes from `useAudioRecorder(AUDIO_RECORDING_OPTIONS)` (the documented way). */
export function createAudioDriver(recorder: AudioRecorder): VoiceDriver {
  let listener: Listener | null = null
  let prepared = false
  let sub: { remove: () => void } | null = null
  const emit = (e: DriverEvent) => listener?.(e)

  async function begin() {
    try {
      if (!prepared) {
        await setAudioModeAsync({
          allowsRecording: true,
          playsInSilentMode: true,
          interruptionMode: 'doNotMix',
        })
        await recorder.prepareToRecordAsync()
        prepared = true
      }
      recorder.record()
      emit({ type: 'started' })
    } catch (e) {
      emit({ type: 'ended', file: recorder.uri, cause: 'error', error: String(e) })
    }
  }

  async function end(cause: 'requested' | 'error') {
    try {
      await recorder.stop()
    } catch {
      // Already stopped: the file is whatever was written.
    }
    await setAudioModeAsync({ allowsRecording: false }).catch(() => {})
    emit({ type: 'ended', file: recorder.uri, cause })
  }

  return {
    liveDraft: false,
    mimeType: 'audio/mp4',
    mode: 'single',
    start: () => void begin(),
    pause: () => recorder.pause(),
    stop: () => void end('requested'),
    abort() {
      listener = null
      void recorder.stop().catch(() => {})
      void setAudioModeAsync({ allowsRecording: false }).catch(() => {})
    },
    subscribe(l) {
      listener = l
      sub = recorder.addListener('recordingStatusUpdate', (status) => {
        // The system's media services reset: the recorder is gone; keep what was written.
        if (status.hasError || status.mediaServicesDidReset) {
          prepared = false
          emit({
            type: 'ended',
            file: recorder.uri,
            cause: status.mediaServicesDidReset ? 'interrupted' : 'error',
            ...(status.error ? { error: status.error } : {}),
          })
        }
      })
      return () => {
        listener = null
        sub?.remove()
        sub = null
      }
    },
  }
}
