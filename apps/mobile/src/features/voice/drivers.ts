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
import { createAttempts, endCause, endedFile } from './attempts'
import { segmentName } from './save'
import type { DriverEvent, VoiceDriver } from './session'
import { VOICE_FORMAT } from './wav'

type Listener = (e: DriverEvent) => void

/** `dir` is the session folder's uri; `exists` tells whether a segment file was written. */
export function createSpeechDriver(dir: string, exists: (uri: string) => boolean): VoiceDriver {
  let listener: Listener | null = null
  let segment = 0
  const attempts = createAttempts()
  let subs: { remove: () => void }[] = []
  const emit = (e: DriverEvent) => listener?.(e)

  function attach() {
    const m = ExpoSpeechRecognitionModule
    subs = [
      m.addListener('start', () => emit({ type: 'started' })),
      m.addListener('result', (e) => {
        const text = e.results[0]?.transcript
        if (text !== undefined) emit({ type: 'draft', text })
      }),
      m.addListener('error', (e) => attempts.error(e.error)),
      m.addListener('audioend', (e) => attempts.audioEnd(e.uri)),
      m.addListener('end', () => {
        const a = attempts.end()
        if (!a) return
        emit({
          type: 'ended',
          file: endedFile(a, exists),
          cause: endCause(a),
          ...(a.error ? { error: a.error } : {}),
        })
      }),
    ]
  }

  return {
    liveDraft: true,
    mimeType: 'audio/wav',
    mode: 'segments',
    start() {
      segment += 1
      const name = segmentName(segment)
      attempts.begin(`${dir}${name}`)
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
          outputFileName: name,
          outputSampleRate: VOICE_FORMAT.sampleRate,
          outputEncoding: 'pcmFormatInt16',
        },
      })
    },
    pause() {
      attempts.requestStop()
      ExpoSpeechRecognitionModule.stop()
    },
    stop() {
      attempts.requestStop()
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
  let watch: ReturnType<typeof setInterval> | null = null
  const emit = (e: DriverEvent) => listener?.(e)

  /**
   * AVAudioRecorder is paused by iOS when a call or Siri takes the microphone, without telling
   * expo-audio's listeners: notice it from the recorder's state while we expect it to record.
   */
  function watchForInterruption() {
    unwatch()
    watch = setInterval(() => {
      if (!recorder.isRecording) {
        unwatch()
        emit({ type: 'interrupted' })
      }
    }, 500)
  }
  function unwatch() {
    if (watch) clearInterval(watch)
    watch = null
  }

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
      watchForInterruption()
    } catch (e) {
      emit({ type: 'ended', file: recorder.uri, cause: 'error', error: String(e) })
    }
  }

  async function end(cause: 'requested' | 'error') {
    unwatch()
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
    pause() {
      unwatch()
      recorder.pause()
    },
    stop: () => void end('requested'),
    abort() {
      listener = null
      unwatch()
      void recorder.stop().catch(() => {})
      void setAudioModeAsync({ allowsRecording: false }).catch(() => {})
    },
    subscribe(l) {
      listener = l
      sub = recorder.addListener('recordingStatusUpdate', (status) => {
        // The system's media services reset: the recorder is gone; keep what was written.
        if (status.hasError || status.mediaServicesDidReset) {
          prepared = false
          unwatch()
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
        unwatch()
        sub?.remove()
        sub = null
      }
    },
  }
}
