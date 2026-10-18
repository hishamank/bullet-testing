/**
 * Which segment file a native recognizer event belongs to (pure). Each `start()` is one attempt
 * with its own file name, fixed at start time. The native events (`error`, `audioend`, `end`)
 * arrive in order and always belong to the OLDEST attempt not yet ended, so a late `end` from a
 * pause can never be credited to the segment that a later start is still writing.
 */

import type { DriverEvent } from './session'

export interface Attempt {
  /** The file this attempt writes (fixed when it starts). */
  file: string
  /** We asked it to stop (pause or Send). */
  requested: boolean
  error: string | null
  /** The file the native side reported on `audioend`, when it did. */
  audioUri: string | null
}

/** Errors that only mean "nothing was heard": the recording itself is fine. */
const BENIGN_ERRORS = new Set(['no-speech', 'speech-timeout', 'aborted'])

export function endCause(a: Attempt): Extract<DriverEvent, { type: 'ended' }>['cause'] {
  if (a.requested) return 'requested'
  if (a.error === 'interrupted') return 'interrupted'
  if (a.error && !BENIGN_ERRORS.has(a.error)) return 'error'
  return 'recognizer'
}

export function createAttempts() {
  const open: Attempt[] = []
  return {
    begin(file: string): Attempt {
      const a: Attempt = { file, requested: false, error: null, audioUri: null }
      open.push(a)
      return a
    },
    /** Pause/Send: the running (newest) attempt was asked to stop. */
    requestStop() {
      const a = open.at(-1)
      if (a) a.requested = true
    },
    error(code: string) {
      const a = open[0]
      if (a && a.error === null) a.error = code
    },
    audioEnd(uri: string | null) {
      const a = open[0]
      if (a && uri) a.audioUri = uri
    },
    /** The oldest open attempt ended; undefined if none was open. */
    end(): Attempt | undefined {
      return open.shift()
    },
    get openCount() {
      return open.length
    },
  }
}

/** The file to report for an ended attempt: the native uri, else ours if it was written. */
export function endedFile(a: Attempt, exists: (uri: string) => boolean): string | null {
  if (a.audioUri && exists(a.audioUri)) return a.audioUri
  return exists(a.file) ? a.file : null
}
