/** Read models for the (future) screens. Pure functions over the local database. */

import {
  type BulletProcessingStatus,
  displayStatus,
  isReflectiveShowing,
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

type SuggestionRow = typeof suggestions.$inferSelect

/** Ids of proposed trackers not created yet ("Start tracking Sleep?", waiting or just decided). */
function proposedTrackerIds(db: PhoneDb): Set<string> {
  return new Set(
    db
      .select({ id: suggestions.id })
      .from(suggestions)
      .where(
        and(
          eq(suggestions.state, 'active'),
          eq(suggestions.target_kind, 'tracker'),
          eq(suggestions.operation, 'create'),
          isNull(suggestions.applied_entity_id),
        ),
      )
      .all()
      .map((r) => r.id),
  )
}

/**
 * A reading logged under a tracker that is itself only proposed: it is decided together with that
 * tracker ("Start tracking Sleep?" logs it; "Not now" dismisses it), never on its own.
 */
export function waitsOnProposedTracker(s: SuggestionRow, proposed: ReadonlySet<string>): boolean {
  return (
    s.target_kind === 'tracker_entry' &&
    s.operation === 'create' &&
    typeof s.payload.tracker_id === 'string' &&
    proposed.has(s.payload.tracker_id)
  )
}

/** Pending suggestions, oldest first (readings waiting on a proposed tracker included). */
function allPending(db: PhoneDb): SuggestionRow[] {
  return db
    .select()
    .from(suggestions)
    .where(and(eq(suggestions.state, 'active'), eq(suggestions.status, 'pending')))
    .orderBy(suggestions.created_at)
    .all()
}

/**
 * Suggestions waiting for the user's decision, oldest first. A reading waiting on a proposed
 * tracker is not one: it goes with that tracker's decision.
 */
export function listPendingSuggestions(db: PhoneDb): SuggestionRow[] {
  const proposed = proposedTrackerIds(db)
  return allPending(db).filter((s) => !waitsOnProposedTracker(s, proposed))
}

/** Pending readings that wait on a proposed tracker (shown on that tracker's card). */
export function listReadingsWaitingOnTrackers(db: PhoneDb): SuggestionRow[] {
  const proposed = proposedTrackerIds(db)
  return allPending(db).filter((s) => waitsOnProposedTracker(s, proposed))
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

/**
 * "To clarify": clarifying questions still open, oldest first (the ones the Inbox badge counts).
 * "Start tracking …?" is asked on the tracker's own Inbox card (Start tracking / Not now), so it
 * is not repeated as a question while that suggestion is on the phone. Reflective questions are
 * never here: see {@link listQuestionsToThinkAbout}.
 */
export function listOpenQuestions(db: PhoneDb) {
  const open = db
    .select()
    .from(questions)
    .where(
      and(
        eq(questions.state, 'active'),
        eq(questions.status, 'open'),
        eq(questions.kind, 'clarifying'),
      ),
    )
    .orderBy(questions.created_at)
    .all()
  const onCard = open.filter((q) => q.topic === 'new_tracker' && q.suggestion_id !== null)
  if (onCard.length === 0) return open
  const present = new Set(
    db
      .select({ id: suggestions.id })
      .from(suggestions)
      .where(
        and(
          eq(suggestions.state, 'active'),
          inArray(
            suggestions.id,
            onCard.map((q) => q.suggestion_id as string),
          ),
        ),
      )
      .all()
      .map((r) => r.id),
  )
  return open.filter(
    (q) => !(q.topic === 'new_tracker' && q.suggestion_id !== null && present.has(q.suggestion_id)),
  )
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

type QuestionRow = typeof questions.$inferSelect
type BulletRow = typeof bullets.$inferSelect

/** A reflective question with the capture it is about (null for an evergreen one). */
export interface ReflectiveQuestionView {
  question: QuestionRow
  source: Pick<BulletRow, 'id' | 'text' | 'captured_at' | 'source' | 'timezone'> | null
}

function withSources(db: PhoneDb, rows: QuestionRow[]): ReflectiveQuestionView[] {
  const ids = [...new Set(rows.map((q) => q.source_bullet_id).filter((x): x is string => !!x))]
  const byId = new Map(
    (ids.length === 0
      ? []
      : db
          .select({
            id: bullets.id,
            text: bullets.text,
            captured_at: bullets.captured_at,
            source: bullets.source,
            timezone: bullets.timezone,
          })
          .from(bullets)
          .where(and(inArray(bullets.id, ids), eq(bullets.state, 'active')))
          .all()
    ).map((b) => [b.id, b]),
  )
  return rows.map((question) => ({
    question,
    source: question.source_bullet_id ? (byId.get(question.source_bullet_id) ?? null) : null,
  }))
}

/**
 * "To think about": reflective questions showing at `now` (open, or back from "Later"), oldest
 * first. Never counted in the Inbox badge, never notified.
 */
export function listQuestionsToThinkAbout(db: PhoneDb, now: number): ReflectiveQuestionView[] {
  const rows = db
    .select()
    .from(questions)
    .where(
      and(
        eq(questions.state, 'active'),
        eq(questions.kind, 'reflective'),
        inArray(questions.status, ['open', 'snoozed']),
      ),
    )
    .orderBy(questions.created_at)
    .all()
    .filter((q) => isReflectiveShowing(q, now))
  return withSources(db, rows)
}

/** An answered reflective question with every capture that answered it ("Add more"), in order. */
export interface AnsweredReflectiveView extends ReflectiveQuestionView {
  answers: Pick<BulletRow, 'id' | 'text' | 'captured_at' | 'source'>[]
}

/**
 * "Answered · N": reflective questions the user journaled about, most recently answered first,
 * each with its answering captures. `count` is the N.
 */
export function listAnsweredReflective(db: PhoneDb): {
  count: number
  items: AnsweredReflectiveView[]
} {
  const rows = db
    .select()
    .from(questions)
    .where(
      and(
        eq(questions.state, 'active'),
        eq(questions.kind, 'reflective'),
        eq(questions.status, 'answered'),
      ),
    )
    .all()
  const answers =
    rows.length === 0
      ? []
      : db
          .select({
            id: bullets.id,
            text: bullets.text,
            captured_at: bullets.captured_at,
            source: bullets.source,
            answers_question_id: bullets.answers_question_id,
          })
          .from(bullets)
          .where(
            and(
              eq(bullets.state, 'active'),
              inArray(
                bullets.answers_question_id,
                rows.map((q) => q.id),
              ),
            ),
          )
          .orderBy(bullets.captured_at)
          .all()
  const items = withSources(db, rows)
    .map((v) => ({
      ...v,
      answers: answers
        .filter((a) => a.answers_question_id === v.question.id)
        .map(({ answers_question_id, ...a }) => {
          void answers_question_id
          return a
        }),
    }))
    .sort(
      (a, b) =>
        (b.answers.at(-1)?.captured_at ?? b.question.resolved_at ?? 0) -
        (a.answers.at(-1)?.captured_at ?? a.question.resolved_at ?? 0),
    )
  return { count: items.length, items }
}
