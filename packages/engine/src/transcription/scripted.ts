/** A scripted {@link Transcriber} for tests: answers from a handler and records every request. */

import { EngineError } from '../errors'
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
 * result passes: an empty transcript is a failure (`TRANSCRIPTION_FAILED`), never an empty bullet.
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
            if (res.text.trim() === '') {
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
