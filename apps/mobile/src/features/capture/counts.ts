/** Read models for the capture page's corners and status line. Pure queries over the local mirror. */

import { and, eq, inArray, sql } from 'drizzle-orm'
import type { PhoneDb } from '../../data/db'
import { bulletsWithPendingChanges } from '../../data/mirror'
import { listOpenQuestions, listPendingSuggestions } from '../../data/queries'
import { bullets, outbox } from '../../data/schema'
import { keptAsAudio } from '../journal/audio-only'

export interface CaptureCounts {
  /** Captures with a change the server hasn't confirmed ("N on this phone"). */
  onPhone: number
  /**
   * Failed captures (no unsent retry or edit), oldest first: Retry targets these. Recordings that
   * can't be transcribed are not here (retrying can't help).
   */
  failedIds: string[]
  /**
   * Failed voice captures whose recording can't be transcribed (`transcription_failed`), oldest
   * first: they need "Write it down" or "Keep as audio", not Retry. Ones kept as audio are left
   * out of both lists.
   */
  untranscribableIds: string[]
  /** Something sits in the server's queue or is being read: worth pulling soon. */
  awaitingServer: boolean
  /** Ops waiting to be sent. */
  outbox: number
}

export function captureCounts(db: PhoneDb): CaptureCounts {
  const pending = bulletsWithPendingChanges(db)
  const active = eq(bullets.state, 'active')
  const failed = db
    .select({ id: bullets.id, code: bullets.server_error_code })
    .from(bullets)
    .where(and(active, eq(bullets.server_status, 'failed')))
    .orderBy(bullets.captured_at)
    .all()
    .filter((r) => !pending.has(r.id))
  const audioOnly = keptAsAudio(
    db,
    failed.map((r) => r.id),
  )
  const shown = failed.filter((r) => !audioOnly.has(r.id))
  const failedIds = shown.filter((r) => r.code !== 'transcription_failed').map((r) => r.id)
  const untranscribableIds = shown.filter((r) => r.code === 'transcription_failed').map((r) => r.id)
  const awaiting =
    db
      .select({ n: sql<number>`count(*)` })
      .from(bullets)
      .where(and(active, inArray(bullets.server_status, ['synced', 'transcribing', 'processing'])))
      .get()?.n ?? 0
  const outboxCount =
    db
      .select({ n: sql<number>`count(*)` })
      .from(outbox)
      .get()?.n ?? 0
  const onPhone =
    pending.size === 0
      ? 0
      : db
          .select({ id: bullets.id })
          .from(bullets)
          .where(and(active, inArray(bullets.id, [...pending])))
          .all().length
  return {
    onPhone,
    failedIds,
    untranscribableIds,
    awaitingServer: awaiting > 0,
    outbox: outboxCount,
  }
}

/** The Inbox corner count: suggestions waiting for a decision plus open questions. */
export function inboxCount(db: PhoneDb): number {
  return listPendingSuggestions(db).length + listOpenQuestions(db).length
}
