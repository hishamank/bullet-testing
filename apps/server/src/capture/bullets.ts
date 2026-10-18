/**
 * Bullet operations from the phone: capture, edit, delete, retry. Each runs inside the push
 * transaction for its op and throws {@link ApplyError} to refuse.
 */

import type { BulletDeleteMode, PushOp } from '@bullet/core'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { audioAttachments, bullets, suggestions, transcripts } from '../db/schema'
import { declareAudio } from './audio'
import { answerQuestion, retireThoughtsAndQuestions } from './thoughts'
import { ApplyError } from '../apply/apply'
import { ENTITY_KINDS, listActiveBySource, softDeleteEntity } from '../apply/entities'
import { retireSuggestion } from '../apply/reconcile'
import { touch } from '../sync/changes'
import { type BulletRow, cancelJob, enqueue } from '../queue/jobs'

type CreateOp = Extract<PushOp, { type: 'bullet.create' }>

function getBullet(db: Db, ownerId: string, id: string): BulletRow {
  const b = db
    .select()
    .from(bullets)
    .where(and(eq(bullets.id, id), eq(bullets.owner_id, ownerId)))
    .get()
  if (!b) throw new ApplyError('not_found', `bullet ${id} not found`)
  return b
}

/**
 * Store a new capture (and a voice note's recording metadata + draft) and queue it. Idempotent by
 * the client-minted id: the same bullet again is a `duplicate` (its text may have changed since,
 * by an edit or a transcript); the same id with a different capture is refused.
 */
export function createBullet(
  db: Db,
  ownerId: string,
  input: CreateOp['bullet'],
  now: number,
): 'applied' | 'duplicate' {
  const existing = db.select().from(bullets).where(eq(bullets.id, input.id)).get()
  if (existing) {
    const same =
      existing.owner_id === ownerId &&
      existing.captured_at === input.captured_at &&
      existing.source === input.source
    if (same) return 'duplicate'
    throw new ApplyError('invalid', `bullet id ${input.id} is already used`)
  }
  const row: BulletRow = {
    id: input.id,
    owner_id: ownerId,
    created_at: now,
    updated_at: now,
    state: 'active',
    text: input.text,
    captured_at: input.captured_at,
    timezone: input.timezone,
    source: input.source,
    text_edited_by_user: input.text_edited_by_user ?? false,
    answers_question_id: input.answers_question_id ?? null,
    text_updated_at: input.captured_at,
    text_version: 1,
    proc_status: 'synced',
    proc_attempts: 0,
    proc_error_code: null,
    proc_error_message: null,
    proc_next_retry_at: null,
    proc_updated_at: now,
  }
  db.insert(bullets).values(row).run()
  if (input.audio) declareAudio(db, ownerId, row.id, input.audio, input.captured_at, now)
  if (input.answers_question_id) {
    try {
      answerQuestion(db, ownerId, input.answers_question_id, row.id, now)
    } catch (err) {
      // An answer to a question that no longer exists is still a capture: keep it.
      if (!(err instanceof ApplyError)) throw err
    }
  }
  enqueue(db, row, now)
  return 'applied'
}

/** Change the text and re-process; the reconcile step keeps what still matches. */
export function editBullet(
  db: Db,
  ownerId: string,
  bulletId: string,
  text: string,
  editedAt: number,
  now: number,
): void {
  const b = getBullet(db, ownerId, bulletId)
  if (b.state !== 'active') throw new ApplyError('invalid', 'bullet was deleted')
  if (editedAt < b.text_updated_at) {
    throw new ApplyError('stale', 'a newer version of this bullet exists')
  }
  if (text === b.text) return
  const next = {
    ...b,
    text,
    text_updated_at: editedAt,
    text_version: b.text_version + 1,
    text_edited_by_user: true,
  }
  db.update(bullets)
    .set({
      text,
      text_updated_at: editedAt,
      text_version: next.text_version,
      // From now on the user's words win over any server transcript.
      text_edited_by_user: true,
      // New content, new count: the attempts shown are for this text.
      proc_attempts: 0,
      updated_at: now,
    })
    .where(eq(bullets.id, b.id))
    .run()
  enqueue(db, next, now)
}

/**
 * Soft-delete a bullet. Its waiting suggestions are withdrawn either way; `cascade` also undoes
 * what it applied and soft-deletes everything extracted from it.
 */
export function deleteBullet(
  db: Db,
  ownerId: string,
  bulletId: string,
  mode: BulletDeleteMode,
  now: number,
): void {
  const b = getBullet(db, ownerId, bulletId)
  if (b.state === 'deleted') return
  cancelJob(db, b.id, now)
  const own = db
    .select()
    .from(suggestions)
    .where(and(eq(suggestions.source_bullet_id, b.id), eq(suggestions.state, 'active')))
    .all()
  for (const s of own) {
    if (mode === 'cascade' || s.status === 'pending') retireSuggestion(db, s, now)
  }
  if (mode === 'cascade') {
    for (const kind of ENTITY_KINDS) {
      for (const e of listActiveBySource(db, kind, ownerId, b.id)) {
        softDeleteEntity(db, kind, ownerId, e.id, now)
      }
    }
  }
  // The recording and its transcripts belong to the bullet (not extractions): they go with it in
  // both modes — soft-deleted, the audio file itself is kept.
  for (const a of db
    .select()
    .from(audioAttachments)
    .where(eq(audioAttachments.bullet_id, b.id))
    .all()) {
    db.update(audioAttachments)
      .set({ state: 'deleted', updated_at: now })
      .where(eq(audioAttachments.id, a.id))
      .run()
    touch(db, ownerId, 'audio_attachments', a.id)
  }
  for (const t of db.select().from(transcripts).where(eq(transcripts.bullet_id, b.id)).all()) {
    db.update(transcripts)
      .set({ state: 'deleted', updated_at: now })
      .where(eq(transcripts.id, t.id))
      .run()
    touch(db, ownerId, 'transcripts', t.id)
  }
  retireThoughtsAndQuestions(db, ownerId, b.id, now)
  db.update(bullets).set({ state: 'deleted', updated_at: now }).where(eq(bullets.id, b.id)).run()
  touch(db, ownerId, 'bullets', b.id)
}

/** Re-queue a failed bullet. A bullet that isn't failed is left alone (double-tap safe). */
export function retryBullet(db: Db, ownerId: string, bulletId: string, now: number): void {
  const b = getBullet(db, ownerId, bulletId)
  if (b.state !== 'active') throw new ApplyError('invalid', 'bullet was deleted')
  if (b.proc_status !== 'failed') return
  enqueue(db, b, now)
}
