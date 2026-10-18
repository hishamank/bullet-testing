/**
 * Join a recording's WAV segments into one file (see `wav.ts`). File access is injected so the
 * same code runs on the phone (expo-file-system) and in Vitest (in memory). Copies in chunks: an
 * hour of audio is ~115 MB and never sits in memory at once.
 */

import { type ConcatPlan, planConcat, WAV_HEAD_BYTES } from './wav'

export interface VoiceFileIo {
  size: (uri: string) => number
  /** Up to `length` bytes from `offset` (fewer at the end of the file). */
  read: (uri: string, offset: number, length: number) => Uint8Array
  /** Create (or truncate) the file and write these bytes. */
  create: (uri: string, bytes: Uint8Array) => void
  append: (uri: string, bytes: Uint8Array) => void
}

const CHUNK_BYTES = 1024 * 1024

/** Writes `out` and returns what was written, or null when the segments hold no audio. */
export function assembleSegments(
  segments: readonly string[],
  out: string,
  io: VoiceFileIo,
): ConcatPlan | null {
  const heads = segments.map((uri) => {
    const size = io.size(uri)
    return { uri, size, head: io.read(uri, 0, Math.min(size, WAV_HEAD_BYTES)) }
  })
  const plan = planConcat(heads)
  if (!plan) return null
  io.create(out, plan.header)
  for (const c of plan.copies) {
    for (let done = 0; done < c.length;) {
      const bytes = io.read(c.uri, c.offset + done, Math.min(CHUNK_BYTES, c.length - done))
      if (bytes.length === 0) throw new Error(`recording segment ${c.uri} ended early`)
      io.append(out, bytes)
      done += bytes.length
    }
  }
  return plan
}
