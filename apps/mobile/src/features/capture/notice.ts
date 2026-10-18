/**
 * The one quiet line under the mic, and the corner labels (pure). Calm by default: one message
 * at a time, never a warning for being offline.
 */

import type { BulletProcessingStatus } from '@bullet/core'

export type CaptureNotice =
  | { kind: 'saved' }
  | { kind: 'failed'; count: number }
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
}

export function captureNotice(i: NoticeInput): CaptureNotice {
  if (i.saved) return { kind: 'saved' }
  if (i.unpaired) return { kind: 'unpaired', count: i.onPhoneCount }
  if (i.failedCount > 0) return { kind: 'failed', count: i.failedCount }
  if (i.onPhoneCount > 0 && i.cannotReachServer) return { kind: 'on_phone', count: i.onPhoneCount }
  return { kind: 'none' }
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

export const onPhoneText = (n: number) => `${n} on this phone · will sync`

/** The one quiet, tappable line while no home server is paired (tapping opens pairing). */
export const unpairedText = (n: number) =>
  n === 0
    ? "Saved on this phone · Pair a home server when you're ready"
    : `${n} saved on this phone · Pair to sync`

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
