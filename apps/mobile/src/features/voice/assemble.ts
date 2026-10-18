/**
 * Join a recording's WAV segments into one file (see `wav.ts`). File access is injected so the
 * same code runs on the phone (expo-file-system) and in Vitest (in memory). Copies in chunks: an
 * hour of audio is ~115 MB and never sits in memory at once.
 */

import { createSha256 } from './sha256'
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
/** File access and hashing are synchronous: hand the JS thread back this often. */
const YIELD_EVERY_BYTES = 8 * CHUNK_BYTES

/** Waits a macrotask, so touches and frames get through between chunks. */
export type Pause = () => Promise<void>
const nextTask: Pause = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Counts bytes and pauses every YIELD_EVERY_BYTES. */
function pacer(pause: Pause) {
  let sinceYield = 0
  return async (bytes: number) => {
    sinceYield += bytes
    if (sinceYield < YIELD_EVERY_BYTES) return
    sinceYield = 0
    await pause()
  }
}

/** SHA-256 of a whole file, read in chunks. */
export async function hashFile(
  io: VoiceFileIo,
  uri: string,
  pause: Pause = nextTask,
): Promise<string> {
  const hash = createSha256()
  const paced = pacer(pause)
  const size = io.size(uri)
  for (let done = 0; done < size;) {
    const bytes = io.read(uri, done, Math.min(CHUNK_BYTES, size - done))
    if (bytes.length === 0) break
    hash.update(bytes)
    done += bytes.length
    await paced(bytes.length)
  }
  return hash.hex()
}

/**
 * Writes `out` and returns what was written (with its SHA-256, computed on the way), or null when
 * the segments hold no audio.
 */
export async function assembleSegments(
  segments: readonly string[],
  out: string,
  io: VoiceFileIo,
  pause: Pause = nextTask,
): Promise<(ConcatPlan & { sha256: string }) | null> {
  const heads = segments.map((uri) => {
    const size = io.size(uri)
    return { uri, size, head: io.read(uri, 0, Math.min(size, WAV_HEAD_BYTES)) }
  })
  const plan = planConcat(heads)
  if (!plan) return null
  const hash = createSha256()
  const paced = pacer(pause)
  io.create(out, plan.header)
  hash.update(plan.header)
  for (const c of plan.copies) {
    for (let done = 0; done < c.length;) {
      const bytes = io.read(c.uri, c.offset + done, Math.min(CHUNK_BYTES, c.length - done))
      if (bytes.length === 0) throw new Error(`recording segment ${c.uri} ended early`)
      io.append(out, bytes)
      hash.update(bytes)
      done += bytes.length
      await paced(bytes.length)
    }
  }
  return { ...plan, sha256: hash.hex() }
}
