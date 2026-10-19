/** A scripted {@link Transcriber} for tests: answers from a handler and records every request. */

import { EngineError } from '../errors'
import { hasSpeech } from './speech'
import type { Transcriber, TranscriptionRequest, TranscriptionResult } from './types'

export interface ScriptedTranscriber extends Transcriber {
  readonly calls: TranscriptionRequest[]
}

export function createScriptedTranscriber(
  handler: (
    req: TranscriptionRequest,
  ) =>
    | (Partial<TranscriptionResult> & { text: string })
    | Promise<Partial<TranscriptionResult> & { text: string }>,
): ScriptedTranscriber {
  const calls: TranscriptionRequest[] = []
  return {
    calls,
    async transcribe(req) {
      calls.push(req)
      const r = await handler(req)
      return { engine: 'scripted', model: null, languages: [], ...r }
    },
  }
}

/**
 * A deadline for any {@link Transcriber} (rejects with `TRANSCRIBER_TIMEOUT`), and the guard every
 * result passes: a transcript with no words is a failure (`TRANSCRIPTION_FAILED`), never a bullet
 * whose text is "." or empty.
 */
export function withTranscriberTimeout(inner: Transcriber, timeoutMs: number): Transcriber {
  return {
    transcribe(req) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new EngineError(
                'TRANSCRIBER_TIMEOUT',
                `transcription did not finish in ${timeoutMs}ms`,
              ),
            ),
          timeoutMs,
        )
        inner.transcribe(req).then(
          (res) => {
            clearTimeout(timer)
            if (!hasSpeech(res.text)) {
              reject(new EngineError('TRANSCRIPTION_FAILED', 'no speech found in the recording'))
            } else resolve({ ...res, text: res.text.trim() })
          },
          (err: unknown) => {
            clearTimeout(timer)
            reject(err instanceof Error ? err : new Error(String(err)))
          },
        )
      })
    },
  }
}
