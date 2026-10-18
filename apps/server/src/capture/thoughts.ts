/**
 * Persisting the thoughts and clarifying questions of a processed capture, and the user's actions
 * on them (re-classify or resolve a thought, dismiss or answer a question). Tapping an answer
 * option acts on suggestions and lives in `apply/answer.ts`.
 */

import { randomUUID } from 'node:crypto'
import type { CaptureQuestionDraft, SegmentedThought } from '@bullet/engine'
import { RESOLVABLE_THOUGHT_KINDS, type ThoughtKind } from '@bullet/core'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { questions, thoughts } from '../db/schema'
import { ApplyError } from '../apply/apply'
import { touch } from '../sync/changes'

const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, ' ')

/**
 * Replace a capture's thoughts with a fresh segmentation, keeping identity where the text still
 * matches (so ids, links and USER re-classifications survive an edit). Thoughts that disappeared
 * are soft-deleted. Returns the thought id for each segmented position.
 */
export function reconcileThoughts(
  db: Db,
  bullet: { id: string; owner_id: string },
  segmented: SegmentedThought[],
  now: number,
): string[] {
  const pool = db
    .select()
    .from(thoughts)
    .where(and(eq(thoughts.source_bullet_id, bullet.id), eq(thoughts.state, 'active')))
    .all()
  const ids: string[] = []
  for (const t of segmented) {
    const i = pool.findIndex((e) => norm(e.text) === norm(t.text))
    const span = { span_start: t.span?.start ?? null, span_end: t.span?.end ?? null }
    if (i >= 0) {
      const [e] = pool.splice(i, 1)
      if (!e) continue
      db.update(thoughts)
        .set({
          position: t.position,
          text: t.text,
          ...span,
          // The user's re-classification is sticky.
          ...(e.kind_source === 'user' ? {} : { kind: t.kind }),
          updated_at: now,
        })
        .where(eq(thoughts.id, e.id))
        .run()
      touch(db, bullet.owner_id, 'thoughts', e.id)
      ids.push(e.id)
    } else {
      const id = randomUUID()
      db.insert(thoughts)
        .values({
          id,
          owner_id: bullet.owner_id,
          source_bullet_id: bullet.id,
          position: t.position,
          text: t.text,
          ...span,
          kind: t.kind,
          kind_source: 'engine',
          created_at: now,
          updated_at: now,
        })
        .run()
      touch(db, bullet.owner_id, 'thoughts', id)
      ids.push(id)
    }
  }
  for (const gone of pool) {
    db.update(thoughts)
      .set({ state: 'deleted', updated_at: now })
      .where(eq(thoughts.id, gone.id))
      .run()
    touch(db, bullet.owner_id, 'thoughts', gone.id)
  }
  return ids
}

/**
 * Store the capture's clarifying questions. Still-open questions from a previous run are
 * withdrawn; one the user already answered or dismissed is never asked again.
 */
export function replaceQuestions(
  db: Db,
  bullet: { id: string; owner_id: string },
  drafts: (CaptureQuestionDraft & { thoughtId: string | null; suggestionId: string | null })[],
  now: number,
): void {
  const existing = db
    .select()
    .from(questions)
    .where(and(eq(questions.source_bullet_id, bullet.id), eq(questions.state, 'active')))
    .all()
  const settled = new Set(existing.filter((q) => q.status !== 'open').map((q) => norm(q.text)))
  for (const q of existing.filter((e) => e.status === 'open')) {
    db.update(questions)
      .set({ state: 'deleted', updated_at: now })
      .where(eq(questions.id, q.id))
      .run()
    touch(db, bullet.owner_id, 'questions', q.id)
  }
  for (const d of drafts) {
    if (settled.has(norm(d.text))) continue
    const id = randomUUID()
    db.insert(questions)
      .values({
        id,
        owner_id: bullet.owner_id,
        source_bullet_id: bullet.id,
        source_thought_id: d.thoughtId,
        suggestion_id: d.suggestionId,
        kind: 'clarifying',
        topic: d.topic,
        text: d.text,
        options: d.options,
        status: 'open',
        answer_bullet_id: null,
        resolved_at: null,
        created_at: now,
        updated_at: now,
      })
      .run()
    touch(db, bullet.owner_id, 'questions', id)
  }
}

export function reclassifyThought(
  db: Db,
  ownerId: string,
  thoughtId: string,
  kind: ThoughtKind,
  now: number,
) {
  const t = db
    .select()
    .from(thoughts)
    .where(and(eq(thoughts.id, thoughtId), eq(thoughts.owner_id, ownerId)))
    .get()
  if (!t) throw new ApplyError('not_found', `thought ${thoughtId} not found`)
  if (t.state !== 'active') throw new ApplyError('invalid', 'thought was deleted')
  db.update(thoughts)
    .set({ kind, kind_source: 'user', updated_at: now })
    .where(eq(thoughts.id, t.id))
    .run()
  touch(db, ownerId, 'thoughts', t.id)
}

function getThought(db: Db, ownerId: string, id: string) {
  const t = db
    .select()
    .from(thoughts)
    .where(and(eq(thoughts.id, id), eq(thoughts.owner_id, ownerId)))
    .get()
  if (!t) throw new ApplyError('not_found', `thought ${id} not found`)
  if (t.state !== 'active') throw new ApplyError('invalid', 'thought was deleted')
  return t
}

/**
 * Close an open loop (`to_check` / `question` thought), directly or by a capture "with a note"
 * (`byBulletId`). Already resolved: left as it is.
 */
export function resolveThought(
  db: Db,
  ownerId: string,
  thoughtId: string,
  now: number,
  byBulletId: string | null = null,
): void {
  const t = getThought(db, ownerId, thoughtId)
  if (!(RESOLVABLE_THOUGHT_KINDS as readonly ThoughtKind[]).includes(t.kind)) {
    throw new ApplyError('invalid', `a ${t.kind} thought is not an open loop`)
  }
  if (t.resolved_at !== null) return
  db.update(thoughts)
    .set({ resolved_at: now, resolved_by_bullet_id: byBulletId, updated_at: now })
    .where(eq(thoughts.id, t.id))
    .run()
  touch(db, ownerId, 'thoughts', t.id)
}

/** Re-open a resolved thought. */
export function unresolveThought(db: Db, ownerId: string, thoughtId: string, now: number): void {
  const t = getThought(db, ownerId, thoughtId)
  if (t.resolved_at === null) return
  db.update(thoughts)
    .set({ resolved_at: null, resolved_by_bullet_id: null, updated_at: now })
    .where(eq(thoughts.id, t.id))
    .run()
  touch(db, ownerId, 'thoughts', t.id)
}

export function getQuestion(db: Db, ownerId: string, id: string) {
  const q = db
    .select()
    .from(questions)
    .where(and(eq(questions.id, id), eq(questions.owner_id, ownerId)))
    .get()
  if (!q) throw new ApplyError('not_found', `question ${id} not found`)
  return q
}

export function dismissQuestion(db: Db, ownerId: string, id: string, now: number): void {
  const q = getQuestion(db, ownerId, id)
  if (q.status !== 'open') return
  db.update(questions)
    .set({ status: 'dismissed', resolved_at: now, updated_at: now })
    .where(eq(questions.id, q.id))
    .run()
  touch(db, ownerId, 'questions', q.id)
}

/** A capture answering a question: link it and mark the question answered. */
export function answerQuestion(
  db: Db,
  ownerId: string,
  id: string,
  answerBulletId: string,
  now: number,
) {
  const q = getQuestion(db, ownerId, id)
  if (q.state !== 'active' || q.status === 'answered') return
  db.update(questions)
    .set({
      status: 'answered',
      answer_bullet_id: answerBulletId,
      resolved_at: now,
      updated_at: now,
    })
    .where(eq(questions.id, q.id))
    .run()
  touch(db, ownerId, 'questions', q.id)
}

/** Soft-delete a capture's thoughts and questions (they belong to it, not to its extractions). */
export function retireThoughtsAndQuestions(db: Db, ownerId: string, bulletId: string, now: number) {
  for (const table of [thoughts, questions] as const) {
    const rows = db
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.source_bullet_id, bulletId), eq(table.state, 'active')))
      .all()
    for (const r of rows) {
      db.update(table).set({ state: 'deleted', updated_at: now }).where(eq(table.id, r.id)).run()
      touch(db, ownerId, table === thoughts ? 'thoughts' : 'questions', r.id)
    }
  }
}
