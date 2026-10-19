/** Read models for the capture page's corners and status line. Pure queries over the local mirror. */

import { displayStatus, isPermanentTranscriptionError } from '@bullet/core'
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import type { PhoneDb } from '../../data/db'
import { bulletsWithPendingChanges } from '../../data/mirror'
import { listLoopAnswers } from '../../data/connections'
import { listOpenQuestions, listPendingSuggestions } from '../../data/queries'
import { bullets, outbox, suggestions } from '../../data/schema'
import { keptAsAudio } from '../journal/audio-only'
import type { LatestCapture } from './notice'

export interface CaptureCounts {
  /** Captures with a change the server hasn't confirmed ("N on this phone"). */
  onPhone: number
  /**
   * Failed captures (no unsent retry or edit), oldest first: Retry targets these. Recordings that
   * can't be transcribed are not here (retrying can't help).
   */
  failedIds: string[]
  /**
   * Failed voice captures whose recording can't be transcribed (`transcription_failed` or
   * `transcription_no_speech`), oldest
   * first: they need "Write it down" or "Keep as audio", not Retry. Ones kept as audio are left
   * out of both lists.
   */
  untranscribableIds: string[]
  /** Something sits in the server's queue or is being read: worth pulling soon. */
  awaitingServer: boolean
  /** Ops waiting to be sent. */
  outbox: number
  /** The most recent capture, for the processing feedback line (null when there is none). */
  latest: LatestCapture | null
}

/** The most recent active capture with its shown status and the things found in it. */
export function latestCapture(
  db: PhoneDb,
  pending = bulletsWithPendingChanges(db),
): LatestCapture | null {
  const b = db
    .select({
      id: bullets.id,
      captured_at: bullets.captured_at,
      server_status: bullets.server_status,
    })
    .from(bullets)
    .where(eq(bullets.state, 'active'))
    .orderBy(desc(bullets.captured_at))
    .limit(1)
    .get()
  if (!b) return null
  const things = db
    .select({ kind: suggestions.target_kind, operation: suggestions.operation })
    .from(suggestions)
    .where(
      and(
        eq(suggestions.source_bullet_id, b.id),
        eq(suggestions.state, 'active'),
        ne(suggestions.status, 'rejected'),
        // "Did this close it?" is about another capture's loop, not a thing found here.
        ne(suggestions.target_kind, 'thought_resolve'),
      ),
    )
    .all()
    // A reading of a new tracker is one thing with that tracker ("Start tracking Sleep?").
    .filter((s) => !(s.kind === 'tracker_entry' && s.operation === 'create')).length
  return {
    id: b.id,
    status: displayStatus(b.server_status, pending.has(b.id)),
    capturedAt: b.captured_at,
    things,
  }
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
  const failedIds = shown.filter((r) => !isPermanentTranscriptionError(r.code)).map((r) => r.id)
  const untranscribableIds = shown
    .filter((r) => isPermanentTranscriptionError(r.code))
    .map((r) => r.id)
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
    latest: latestCapture(db, pending),
  }
}

/**
 * The Inbox corner count: suggestions waiting for a decision (a "Did this close it?" included,
 * like any suggestion to decide) plus open clarifying questions. Never Noticed cards or
 * questions to think about.
 */
export function inboxCount(db: PhoneDb): number {
  return (
    listPendingSuggestions(db).length + listLoopAnswers(db).length + listOpenQuestions(db).length
  )
}
