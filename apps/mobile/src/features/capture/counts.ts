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
   * Failed captures (no unsent retry or edit), oldest first: Retry targets these. Recordings kept
   * as audio only (after a failed transcription) are left out.
   */
  failedIds: string[]
  /** Something sits in the server's queue or is being read: worth pulling soon. */
  awaitingServer: boolean
  /** Ops waiting to be sent. */
  outbox: number
}

export function captureCounts(db: PhoneDb): CaptureCounts {
  const pending = bulletsWithPendingChanges(db)
  const active = eq(bullets.state, 'active')
  const failed = db
    .select({ id: bullets.id })
    .from(bullets)
    .where(and(active, eq(bullets.server_status, 'failed')))
    .orderBy(bullets.captured_at)
    .all()
    .map((r) => r.id)
    .filter((id) => !pending.has(id))
  const audioOnly = keptAsAudio(db, failed)
  const failedIds = failed.filter((id) => !audioOnly.has(id))
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
  return { onPhone, failedIds, awaitingServer: awaiting > 0, outbox: outboxCount }
}

/** The Inbox corner count: suggestions waiting for a decision plus open questions. */
export function inboxCount(db: PhoneDb): number {
  return listPendingSuggestions(db).length + listOpenQuestions(db).length
}
