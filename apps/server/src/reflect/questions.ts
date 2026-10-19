/**
 * Reflective questions on the server: the user's state the limits are decided on, and storing a
 * new question. Every new reflective question, whatever its origin, goes through
 * {@link createReflectiveQuestion} inside a transaction that has just checked the limits.
 */

import { randomUUID } from 'node:crypto'
import type { QuestionOrigin } from '@bullet/core'
import { type ReflectiveState, reflectiveRefusal, type ReflectiveRefusal } from '@bullet/engine'
import { and, eq, gt, inArray, max, type SQL, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { bullets, questions, thoughts } from '../db/schema'
import { touch } from '../sync/changes'

const DAY_MS = 24 * 60 * 60 * 1000

/** Open or snoozed: both count against the open cap (a snoozed one comes back). */
export const LIVE_STATUSES = ['open', 'snoozed'] as const

const reflective = (ownerId: string) =>
  and(eq(questions.owner_id, ownerId), eq(questions.kind, 'reflective'))

/** The summary {@link reflectiveRefusal} decides on, read from the database. */
export function reflectiveState(db: Db, ownerId: string, now: number): ReflectiveState {
  const open =
    db
      .select({ n: sql<number>`count(*)` })
      .from(questions)
      .where(
        and(
          reflective(ownerId),
          eq(questions.state, 'active'),
          inArray(questions.status, [...LIVE_STATUSES]),
        ),
      )
      .get()?.n ?? 0
  // Every question made counts toward the day, even one withdrawn since.
  const createdLastDay =
    db
      .select({ n: sql<number>`count(*)` })
      .from(questions)
      .where(and(reflective(ownerId), gt(questions.created_at, now - DAY_MS)))
      .get()?.n ?? 0
  const lastCaptureAt =
    db
      .select({ at: max(bullets.captured_at) })
      .from(bullets)
      .where(and(eq(bullets.owner_id, ownerId), eq(bullets.state, 'active')))
      .get()?.at ?? null
  const lastEvergreenAt =
    db
      .select({ at: max(questions.created_at) })
      .from(questions)
      .where(and(reflective(ownerId), eq(questions.origin, 'evergreen')))
      .get()?.at ?? null
  // A thought's last change: it was flagged then (or re-read since, which only lengthens the pause).
  const lastSensitiveAt =
    db
      .select({ at: max(thoughts.updated_at) })
      .from(thoughts)
      .where(
        and(
          eq(thoughts.owner_id, ownerId),
          eq(thoughts.state, 'active'),
          eq(thoughts.sensitive, true),
        ),
      )
      .get()?.at ?? null
  return { open, createdLastDay, lastCaptureAt, lastEvergreenAt, lastSensitiveAt }
}

/** Why no new question of this origin may be asked now (null: it may). */
export function refusalNow(
  db: Db,
  ownerId: string,
  origin: QuestionOrigin,
  now: number,
): ReflectiveRefusal | null {
  return reflectiveRefusal(origin, reflectiveState(db, ownerId, now), now)
}

export interface NewReflectiveQuestion {
  id?: string
  ownerId: string
  origin: QuestionOrigin
  text: string
  sourceBulletId: string | null
  sourceThoughtId: string | null
  templateId?: string | null
}

/** Store an open reflective question (the caller has checked the limits). Returns its id. */
export function createReflectiveQuestion(db: Db, q: NewReflectiveQuestion, now: number): string {
  const id = q.id ?? randomUUID()
  db.insert(questions)
    .values({
      id,
      owner_id: q.ownerId,
      source_bullet_id: q.sourceBulletId,
      source_thought_id: q.sourceThoughtId,
      suggestion_id: null,
      kind: 'reflective',
      origin: q.origin,
      topic: 'other',
      text: q.text,
      options: [],
      status: 'open',
      answer_bullet_id: null,
      answer_option: null,
      resolved_at: null,
      snoozed_until: null,
      snooze_count: 0,
      template_id: q.templateId ?? null,
      created_at: now,
      updated_at: now,
    })
    .run()
  touch(db, q.ownerId, 'questions', id)
  return id
}

/** Withdraw (soft-delete) reflective questions still open or snoozed, matching `where`. */
export function withdrawLiveReflective(db: Db, ownerId: string, where: SQL, now: number): void {
  const rows = db
    .select({ id: questions.id })
    .from(questions)
    .where(
      and(
        reflective(ownerId),
        eq(questions.state, 'active'),
        inArray(questions.status, [...LIVE_STATUSES]),
        where,
      ),
    )
    .all()
  for (const r of rows) {
    db.update(questions)
      .set({ state: 'deleted', updated_at: now })
      .where(eq(questions.id, r.id))
      .run()
    touch(db, ownerId, 'questions', r.id)
  }
}
