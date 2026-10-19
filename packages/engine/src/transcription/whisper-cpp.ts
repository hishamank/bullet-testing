/**
 * A {@link Transcriber} over whisper.cpp's `whisper-server` HTTP API (`POST /inference`, multipart).
 * Plain `fetch` + `FormData`, no SDK, so it runs anywhere — like the LLM adapter.
 *
 * Every request sends `language=auto`: whisper-server defaults to English, and the user mixes
 * English, Lebanese Arabic and French. whisper.cpp detects one language per recording (from the
 * first 30 s), so `languages` holds at most one entry. Non-WAV audio (the phone records AAC/M4A)
 * needs the server started with `--convert` (ffmpeg on its PATH).
 */

import { EngineError } from '../errors'
import type { Transcriber, TranscriptionRequest, TranscriptionResult } from './types'

export interface WhisperCppOptions {
  /** Server root, e.g. `http://127.0.0.1:8081`. */
  baseUrl: string
  /** Path of the inference route (whisper-server `--inference-path`). Default `/inference`. */
  inferencePath?: string
  /**
   * The model the server was started with, reported as {@link TranscriptionResult.model}
   * (whisper-server does not say). Default `large-v3-turbo`.
   */
  model?: string
  /** Optional initial prompt; biases vocabulary and script (e.g. names, mixed-language style). */
  prompt?: string
  /** Sampling temperature. Default 0 (whisper-server falls back to higher ones on failure). */
  temperature?: number
  /** Abort a request after this many ms. Default 600 000. */
  timeoutMs?: number
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch
}

interface VerboseJson {
  text?: unknown
  language?: unknown
  detected_language?: unknown
  error?: unknown
}

const EXTENSIONS: Record<string, string> = {
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
}

/** whisper.cpp reports full lowercase names; the contract wants ISO 639-1 codes. */
const LANGUAGE_CODES: Record<string, string> = {
  english: 'en',
  arabic: 'ar',
  french: 'fr',
  spanish: 'es',
  german: 'de',
  italian: 'it',
  portuguese: 'pt',
  turkish: 'tr',
  persian: 'fa',
  hebrew: 'he',
  armenian: 'hy',
  greek: 'el',
  russian: 'ru',
  urdu: 'ur',
  hindi: 'hi',
  dutch: 'nl',
  chinese: 'zh',
  japanese: 'ja',
  korean: 'ko',
}

export function whisperLanguageCode(name: string): string | null {
  const key = name.trim().toLowerCase()
  if (/^[a-z]{2,3}$/.test(key)) return key
  return LANGUAGE_CODES[key] ?? null
}

export function createWhisperCppTranscriber(opts: WhisperCppOptions): Transcriber {
  const doFetch = opts.fetch ?? fetch
  const url = `${opts.baseUrl.replace(/\/+$/, '')}${opts.inferencePath ?? '/inference'}`
  const timeoutMs = opts.timeoutMs ?? 600_000
  const model = opts.model ?? 'large-v3-turbo'

  return {
    async transcribe(req: TranscriptionRequest): Promise<TranscriptionResult> {
      const form = new FormData()
      const ext = EXTENSIONS[req.mimeType.split(';')[0]!.trim().toLowerCase()] ?? 'bin'
      // Copied: a Blob needs ArrayBuffer-backed bytes, and `audio` may be a view on any buffer.
      form.append(
        'file',
        new Blob([new Uint8Array(req.audio)], { type: req.mimeType }),
        `audio.${ext}`,
      )
      // Auto-detect always: `languageHints` cannot be passed (whisper.cpp takes one language).
      form.append('language', 'auto')
      form.append('response_format', 'verbose_json')
      form.append('temperature', String(opts.temperature ?? 0))
      if (opts.prompt) form.append('prompt', opts.prompt)

      let res: Response
      try {
        res = await doFetch(url, {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (err) {
        if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
          throw new EngineError(
            'TRANSCRIBER_TIMEOUT',
            `whisper-server did not answer within ${timeoutMs}ms`,
            err,
          )
        }
        throw new EngineError('TRANSCRIBER_HTTP', `whisper-server unreachable: ${String(err)}`, err)
      }

      const bodyText = await res.text()
      // 400 = the server could not read the audio (or, without --convert, it is not WAV).
      if (res.status === 400) {
        throw new EngineError('TRANSCRIPTION_FAILED', 'whisper-server rejected the audio', bodyText)
      }
      // With --convert, audio ffmpeg cannot decode (a damaged recording) answers 500 with
      // "FFmpeg conversion failed.": the recording is the problem, not the server.
      if (res.status === 500 && /conversion failed/i.test(bodyText)) {
        throw new EngineError(
          'TRANSCRIPTION_FAILED',
          'whisper-server could not decode the audio (ffmpeg conversion failed)',
          bodyText,
        )
      }
      if (!res.ok) {
        throw new EngineError(
          'TRANSCRIBER_HTTP',
          `whisper-server responded ${res.status}`,
          bodyText,
        )
      }

      let body: VerboseJson
      try {
        body = JSON.parse(bodyText) as VerboseJson
      } catch {
        throw new EngineError('TRANSCRIBER_HTTP', 'whisper-server answered non-JSON', bodyText)
      }
      if (typeof body.error === 'string') {
        throw new EngineError('TRANSCRIPTION_FAILED', `whisper-server: ${body.error}`, body)
      }
      if (typeof body.text !== 'string') {
        throw new EngineError('TRANSCRIBER_HTTP', 'whisper-server response had no text', body)
      }

      const detected = typeof body.language === 'string' ? body.language : body.detected_language
      const code = typeof detected === 'string' ? whisperLanguageCode(detected) : null
      return {
        // whisper-server joins segments with newlines; a bullet is one flowing text.
        text: body.text.replace(/\s*\n\s*/g, ' ').trim(),
        engine: 'whisper.cpp',
        model,
        languages: code ? [code] : [],
      }
    },
  }
}
