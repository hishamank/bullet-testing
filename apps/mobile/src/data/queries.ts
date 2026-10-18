/** Read models for the (future) screens. Pure functions over the local database. */

import {
  type BulletProcessingStatus,
  displayStatus,
  type ProcessingError,
  RESOLVABLE_THOUGHT_KINDS,
} from '@bullet/core'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import type { PhoneDb } from './db'
import { bulletsWithPendingChanges } from './mirror'
import { bullets, questions, suggestions, thoughts } from './schema'

export interface BulletView {
  id: string
  text: string
  capturedAt: number
  source: 'text' | 'voice'
  status: BulletProcessingStatus
  attempts: number
  error: ProcessingError | null
  nextRetryAt: number | null
  /** The server refused a change to this bullet for good (rare; the pull restores its version). */
  syncRejection: string | null
}

/** The journal stream, newest first, with the status the UI should show. */
export function listBullets(db: PhoneDb, limit = 200): BulletView[] {
  const pending = bulletsWithPendingChanges(db)
  return db
    .select()
    .from(bullets)
    .where(eq(bullets.state, 'active'))
    .orderBy(desc(bullets.captured_at))
    .limit(limit)
    .all()
    .map((b) => ({
      id: b.id,
      text: b.text,
      capturedAt: b.captured_at,
      source: b.source,
      status: displayStatus(b.server_status, pending.has(b.id)),
      attempts: b.server_attempts,
      error: b.server_error_code
        ? { code: b.server_error_code, message: b.server_error_message ?? '' }
        : null,
      nextRetryAt: b.server_next_retry_at,
      syncRejection: b.sync_rejection,
    }))
}

/** Suggestions waiting for the user, oldest first. */
export function listPendingSuggestions(db: PhoneDb) {
  return db
    .select()
    .from(suggestions)
    .where(and(eq(suggestions.state, 'active'), eq(suggestions.status, 'pending')))
    .orderBy(suggestions.created_at)
    .all()
}

/** A capture's thoughts, in order. */
export function listThoughts(db: PhoneDb, bulletId: string) {
  return db
    .select()
    .from(thoughts)
    .where(and(eq(thoughts.source_bullet_id, bulletId), eq(thoughts.state, 'active')))
    .orderBy(thoughts.position)
    .all()
}

/** Clarifying questions still open, oldest first. */
export function listOpenQuestions(db: PhoneDb) {
  return db
    .select()
    .from(questions)
    .where(and(eq(questions.state, 'active'), eq(questions.status, 'open')))
    .orderBy(questions.created_at)
    .all()
}

/** Open loops: unresolved `to_check` / `question` thoughts, oldest first. */
export function listOpenLoops(db: PhoneDb) {
  return db
    .select()
    .from(thoughts)
    .where(
      and(
        eq(thoughts.state, 'active'),
        inArray(thoughts.kind, [...RESOLVABLE_THOUGHT_KINDS]),
        isNull(thoughts.resolved_at),
      ),
    )
    .orderBy(thoughts.created_at)
    .all()
}
