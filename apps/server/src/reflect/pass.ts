/**
 * The daily reflection pass (no model): for each user, in one transaction,
 *  1. snoozed questions whose week is over open again;
 *  2. at most ONE new question: "Still on your mind? «…»" for the oldest open loop (a `to_check`
 *     or `question` thought) unresolved for 7 days, else an evergreen question, if the limits
 *     allow (`reflectiveRefusal`).
 *
 * An open loop gets a question at most once, ever, and never when its thought or capture reads as
 * distress, or the user said "Not this one" about it. Evergreen questions rotate through the list
 * (never offered ones first, then the least recently offered), skipping any the user dismissed.
 *
 * `scheduleReflectionPass` runs it at startup and then every day; tests call `runReflectionPass`.
 */

import {
  EVERGREEN_QUESTIONS,
  REFLECTIVE_CAPS,
  RESOLVABLE_THOUGHT_KINDS,
  staleLoopQuestionText,
} from '@bullet/core'
import { and, asc, eq, inArray, isNull, lte } from 'drizzle-orm'
import type { Db } from '../db/client'
import { bullets, questions, thoughts, users } from '../db/schema'
import { touch } from '../sync/changes'
import { createReflectiveQuestion, refusalNow } from './questions'

export interface PassResult {
  reopened: number
  /** Ids of the questions created (at most one per user). */
  created: string[]
}

/** Snoozed questions whose `snoozed_until` has come: open again (`snooze_count` stays). */
function reopenSnoozed(db: Db, ownerId: string, now: number): number {
  const due = db
    .select({ id: questions.id })
    .from(questions)
    .where(
      and(
        eq(questions.owner_id, ownerId),
        eq(questions.state, 'active'),
        eq(questions.status, 'snoozed'),
        lte(questions.snoozed_until, now),
      ),
    )
    .all()
  for (const q of due) {
    db.update(questions)
      .set({ status: 'open', updated_at: now })
      .where(eq(questions.id, q.id))
      .run()
    touch(db, ownerId, 'questions', q.id)
  }
  return due.length
}

/** The oldest open loop due a "Still on your mind?", if any. */
export function staleLoop(db: Db, ownerId: string, now: number) {
  const loops = db
    .select({
      id: thoughts.id,
      text: thoughts.text,
      bulletId: thoughts.source_bullet_id,
      capturedAt: bullets.captured_at,
    })
    .from(thoughts)
    .innerJoin(bullets, eq(bullets.id, thoughts.source_bullet_id))
    .where(
      and(
        eq(thoughts.owner_id, ownerId),
        eq(thoughts.state, 'active'),
        inArray(thoughts.kind, [...RESOLVABLE_THOUGHT_KINDS]),
        isNull(thoughts.resolved_at),
        eq(thoughts.never_ask, false),
        eq(thoughts.sensitive, false),
        eq(bullets.state, 'active'),
        lte(bullets.captured_at, now - REFLECTIVE_CAPS.staleLoopMs),
      ),
    )
    .orderBy(asc(bullets.captured_at), asc(thoughts.position))
    .all()
  for (const loop of loops) {
    // Asked about once already (as a loop, or about its words from the capture): never again.
    const asked = db
      .select({ id: questions.id })
      .from(questions)
      .where(and(eq(questions.kind, 'reflective'), eq(questions.source_thought_id, loop.id)))
      .get()
    if (asked) continue
    // A capture that reads as distress gets no "Still on your mind?" for any of its loops.
    const distress = db
      .select({ id: thoughts.id })
      .from(thoughts)
      .where(
        and(
          eq(thoughts.source_bullet_id, loop.bulletId),
          eq(thoughts.state, 'active'),
          eq(thoughts.sensitive, true),
        ),
      )
      .get()
    if (distress) continue
    return loop
  }
  return null
}

/** The next evergreen question to offer, or null when every one was dismissed. */
export function nextEvergreen(db: Db, ownerId: string) {
  const offered = db
    .select({
      template: questions.template_id,
      status: questions.status,
      snoozes: questions.snooze_count,
      at: questions.created_at,
    })
    .from(questions)
    .where(and(eq(questions.owner_id, ownerId), eq(questions.origin, 'evergreen')))
    .all()
  // "Not this one" (a dismissal that was not a second "Later") retires a template for good.
  const retired = new Set(
    offered.filter((q) => q.status === 'dismissed' && q.snoozes < 2).map((q) => q.template),
  )
  const lastOffered = new Map<string, number>()
  for (const q of offered) {
    if (q.template !== null)
      lastOffered.set(q.template, Math.max(lastOffered.get(q.template) ?? 0, q.at))
  }
  const candidates = EVERGREEN_QUESTIONS.filter((t) => !retired.has(t.id))
  const fresh = candidates.find((t) => !lastOffered.has(t.id))
  if (fresh) return fresh
  return (
    [...candidates].sort(
      (a, b) => (lastOffered.get(a.id) ?? 0) - (lastOffered.get(b.id) ?? 0),
    )[0] ?? null
  )
}

/** One user's pass, in one transaction. */
export function reflectionPassFor(db: Db, ownerId: string, now: number): PassResult {
  return db.transaction((tx) => {
    const reopened = reopenSnoozed(tx, ownerId, now)
    if (refusalNow(tx, ownerId, 'open_loop', now) === null) {
      const loop = staleLoop(tx, ownerId, now)
      if (loop) {
        const id = createReflectiveQuestion(
          tx,
          {
            ownerId,
            origin: 'open_loop',
            text: staleLoopQuestionText(loop.text),
            sourceBulletId: loop.bulletId,
            sourceThoughtId: loop.id,
          },
          now,
        )
        return { reopened, created: [id] }
      }
    }
    if (refusalNow(tx, ownerId, 'evergreen', now) === null) {
      const template = nextEvergreen(tx, ownerId)
      if (template) {
        const id = createReflectiveQuestion(
          tx,
          {
            ownerId,
            origin: 'evergreen',
            text: template.text,
            sourceBulletId: null,
            sourceThoughtId: null,
            templateId: template.id,
          },
          now,
        )
        return { reopened, created: [id] }
      }
    }
    return { reopened, created: [] }
  })
}

/** The pass for every user. */
export function runReflectionPass(db: Db, now: number): PassResult {
  const out: PassResult = { reopened: 0, created: [] }
  for (const u of db.select({ id: users.id }).from(users).all()) {
    const r = reflectionPassFor(db, u.id, now)
    out.reopened += r.reopened
    out.created.push(...r.created)
  }
  return out
}

export const REFLECTION_PASS_INTERVAL_MS = 24 * 60 * 60 * 1000

/**
 * Run the pass shortly after startup, then every `intervalMs` (a day by default). The limits make
 * an extra run harmless. Returns a stop function.
 */
export function scheduleReflectionPass(
  db: Db,
  opts: {
    now?: () => number
    intervalMs?: number
    firstRunMs?: number
    onError?: (err: unknown) => void
  } = {},
): () => void {
  const now = opts.now ?? Date.now
  const run = () => {
    try {
      runReflectionPass(db, now())
    } catch (err) {
      opts.onError?.(err)
    }
  }
  const first = setTimeout(run, opts.firstRunMs ?? 60_000)
  const every = setInterval(run, opts.intervalMs ?? REFLECTION_PASS_INTERVAL_MS)
  first.unref?.()
  every.unref?.()
  return () => {
    clearTimeout(first)
    clearInterval(every)
  }
}
