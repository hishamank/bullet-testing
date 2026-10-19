/**
 * The one quiet line under the mic, and the corner labels (pure). Calm by default: one message
 * at a time, never a warning for being offline.
 */

import type { BulletProcessingStatus } from '@bullet/core'

export type CaptureNotice =
  | { kind: 'saved' }
  | { kind: 'failed'; count: number }
  /** The latest capture is still on its way through the server (`slow`: over 5 minutes). */
  | { kind: 'sorting'; slow: boolean; bulletId: string }
  /** The latest capture is done and things were found in it (tap opens it). */
  | { kind: 'found'; count: number; bulletId: string }
  /** Recordings that can't be transcribed; `bulletId` when there is exactly one (open it). */
  | { kind: 'untranscribable'; count: number; bulletId: string | null }
  | { kind: 'on_phone'; count: number }
  | { kind: 'unpaired'; count: number }
  | { kind: 'none' }

export interface NoticeInput {
  saved: boolean
  /** Captures the server gave up on (always retryable). */
  failedCount: number
  /** Captures (or edits) the server hasn't confirmed yet. */
  onPhoneCount: number
  /** Offline, or the home server is out of reach. */
  cannotReachServer: boolean
  /** No home server yet ("Not yet" at setup): captures stay on the phone, sync is off. */
  unpaired?: boolean
  /** Recordings the server couldn't transcribe (not retryable), oldest first. */
  untranscribableIds?: readonly string[]
  /** The most recent capture, for the quiet processing feedback; needs `now`. */
  latest?: LatestCapture | null
  now?: number
}

/** The most recent capture, as the processing feedback line needs it. */
export interface LatestCapture {
  id: string
  /** As shown (`saved_local` while a change is unsent). */
  status: BulletProcessingStatus
  capturedAt: number
  /** Things found in it (suggestions not dismissed; a reading counts with its new tracker). */
  things: number
}

/** "Still sorting" once a capture has been on its way this long (from its capture time). */
export const STILL_SORTING_AFTER_MS = 5 * 60_000
/** "N things found" shows for a capture made within this long. */
export const FOUND_SHOWN_MS = 60 * 60_000

const ON_ITS_WAY: readonly BulletProcessingStatus[] = [
  'saved_local',
  'synced',
  'transcribing',
  'processing',
]

export function captureNotice(i: NoticeInput): CaptureNotice {
  if (i.saved) return { kind: 'saved' }
  if (i.unpaired) return { kind: 'unpaired', count: i.onPhoneCount }
  if (i.failedCount > 0) return { kind: 'failed', count: i.failedCount }
  const untranscribable = i.untranscribableIds ?? []
  if (untranscribable.length > 0) {
    return {
      kind: 'untranscribable',
      count: untranscribable.length,
      bulletId: untranscribable.length === 1 ? (untranscribable[0] ?? null) : null,
    }
  }
  if (i.onPhoneCount > 0 && i.cannotReachServer) return { kind: 'on_phone', count: i.onPhoneCount }
  const latest = i.latest
  if (latest && i.now !== undefined) {
    const age = i.now - latest.capturedAt
    if (ON_ITS_WAY.includes(latest.status)) {
      return { kind: 'sorting', slow: age > STILL_SORTING_AFTER_MS, bulletId: latest.id }
    }
    const done = latest.status === 'processed' || latest.status === 'needs_review'
    if (done && latest.things > 0 && age <= FOUND_SHOWN_MS) {
      return { kind: 'found', count: latest.things, bulletId: latest.id }
    }
  }
  return { kind: 'none' }
}

/** Decision 6: quiet, static processing feedback (no spinner, no notification). */
export const SORTING_TEXT = 'Saved. Sorting this out in the background.'
export const STILL_SORTING_TEXT = 'Still sorting. Your capture is safe.'
export const foundText = (n: number) => `${n} ${n === 1 ? 'thing' : 'things'} found`

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

export const onPhoneText = (n: number) => `${n} on this phone · will sync`

/** The one quiet, tappable line while no home server is paired (tapping opens pairing). */
export const unpairedText = (n: number) =>
  n === 0
    ? "Saved on this phone · Pair a home server when you're ready"
    : `${n} saved on this phone · Pair to sync`

export const untranscribableText = (n: number) =>
  `${n} ${plural(n, 'recording', 'recordings')} couldn't be transcribed`

export const failedText = (n: number) =>
  `${n} ${plural(n, 'capture', 'captures')} couldn't be processed`

export const UNREACHABLE_TEXT =
  'Home server unreachable. Your captures are safe on this phone and will sync later.'

export const UNAUTHORIZED_TEXT =
  "The home server didn't accept this phone's token. Your captures are safe on this phone."

export function journalCornerLabel(failedCount: number): string {
  if (failedCount === 0) return 'Open journal'
  return `Open journal, ${failedCount} ${plural(failedCount, 'capture needs', 'captures need')} attention`
}

export function inboxCornerLabel(count: number): string {
  return count === 0 ? 'Open inbox, nothing waiting' : `Open inbox, ${count} waiting`
}

const STATUS_LABELS: Record<BulletProcessingStatus, string> = {
  saved_local: 'on this phone',
  synced: 'waiting for home',
  transcribing: 'transcribing',
  processing: 'reading',
  processed: 'done',
  needs_review: 'waiting for you',
  failed: 'not processed',
}

/** A capture's state in words: "Saved on this phone" must read differently from every server state. */
export const captureStatusLabel = (s: BulletProcessingStatus) => STATUS_LABELS[s]
