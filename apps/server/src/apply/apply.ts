/**
 * The apply engine: turning a Suggestion into a change to the user's data, and back.
 *
 *  - Apply-time revalidation: a suggestion may have waited for days, so applying re-checks the
 *    payload against the kind's schema AND against current state (the target still exists and is
 *    active, the task is still open, the value still fits the tracker).
 *  - Idempotent: a created entity's id IS the suggestion's id, and an already-applied suggestion
 *    returns as-is — applying twice can never duplicate data.
 *  - Field-level updates: an UPDATE writes only the fields in its patch, so it never reverts edits
 *    made since extraction. The previous values are kept for undo.
 *  - Undo: reverts an applied suggestion (soft-deletes what it created, restores what it changed),
 *    refusing with `conflict` when the user has changed that thing by hand since (its
 *    `user_edited_at`, or for kinds without one, any write after the apply).
 *
 * Plain functions over a Db/transaction; routes and the queue are thin callers.
 */

import {
  entryValueFits,
  type PushRejectCode,
  type TrackerEntryValue,
  targetKindInsertSchemas,
  targetKindUpdateSchemas,
  taskSelectSchema,
  eventSelectSchema,
} from '@bullet/core'
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { bullets, suggestions, trackers } from '../db/schema'
import { touch } from '../sync/changes'
import { getEntity, insertEntity, patchEntity, softDeleteEntity } from './entities'

export type SuggestionRow = typeof suggestions.$inferSelect

/** A refusal to apply/undo; its code is what the push response reports. */
export class ApplyError extends Error {
  readonly code: PushRejectCode
  constructor(code: PushRejectCode, message: string) {
    super(message)
    this.name = 'ApplyError'
    this.code = code
  }
}

export function getSuggestion(db: Db, ownerId: string, id: string): SuggestionRow | undefined {
  return db
    .select()
    .from(suggestions)
    .where(and(eq(suggestions.id, id), eq(suggestions.owner_id, ownerId)))
    .get()
}

export function updateSuggestionRow(
  db: Db,
  s: SuggestionRow,
  patch: Partial<SuggestionRow>,
  now: number,
): SuggestionRow {
  const next = { ...s, ...patch, updated_at: now }
  db.update(suggestions)
    .set({ ...patch, updated_at: now })
    .where(eq(suggestions.id, s.id))
    .run()
  touch(db, s.owner_id, 'suggestions', s.id)
  return next
}

/** Re-exported from `@bullet/core`, where the phone shares it. */
export { entryValueFits }

function activeTracker(db: Db, ownerId: string, id: string) {
  const t = db
    .select()
    .from(trackers)
    .where(and(eq(trackers.id, id), eq(trackers.owner_id, ownerId)))
    .get()
  if (!t) throw new ApplyError('not_found', `tracker ${id} not found`)
  if (t.state !== 'active') throw new ApplyError('conflict', `tracker ${id} was deleted`)
  return t
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** Validate + revalidate a create/append and write it. Returns the new entity's id. */
function applyCreate(db: Db, s: SuggestionRow, payload: Record<string, unknown>, now: number) {
  const parsed = targetKindInsertSchemas[s.target_kind].safeParse({
    ...payload,
    owner_id: s.owner_id,
    source_bullet_id: s.source_bullet_id,
  })
  if (!parsed.success) {
    throw new ApplyError('invalid', `payload invalid: ${parsed.error.issues[0]?.message ?? ''}`)
  }
  // Server-managed fields never come from a payload.
  const { id, created_at, updated_at, state, ...data } = parsed.data as Record<string, unknown>
  void id
  void created_at
  void updated_at
  void state

  if (s.operation === 'append') {
    if (s.target_kind !== 'tracker_entry' || s.target_id === null) {
      throw new ApplyError('invalid', `append is only supported for tracker entries`)
    }
    const tracker = activeTracker(db, s.owner_id, s.target_id)
    data.tracker_id = tracker.id
    if (!entryValueFits(data.value as TrackerEntryValue, tracker.config)) {
      throw new ApplyError('invalid', `value does not fit tracker "${tracker.name}"`)
    }
  } else if (s.target_kind === 'tracker_entry') {
    const tracker = activeTracker(db, s.owner_id, String(data.tracker_id))
    if (!entryValueFits(data.value as TrackerEntryValue, tracker.config)) {
      throw new ApplyError('invalid', `value does not fit tracker "${tracker.name}"`)
    }
  } else if (s.target_kind === 'activity' && typeof data.tracker_id === 'string') {
    activeTracker(db, s.owner_id, data.tracker_id)
  } else if (s.target_kind === 'tracker') {
    const dup = db
      .select({ id: trackers.id })
      .from(trackers)
      .where(
        and(
          eq(trackers.owner_id, s.owner_id),
          eq(trackers.state, 'active'),
          sql`lower(${trackers.name}) = lower(${String(data.name)})`,
        ),
      )
      .get()
    if (dup) throw new ApplyError('conflict', `a tracker named "${String(data.name)}" exists`)
  }

  insertEntity(db, s.target_kind, { ...data, id: s.id, owner_id: s.owner_id }, now)
  return { entityId: s.id, before: null, after: null }
}

/** Validate + revalidate a field-level update and write ONLY the patched fields. */
function applyUpdate(db: Db, s: SuggestionRow, payload: Record<string, unknown>, now: number) {
  const parsed = targetKindUpdateSchemas[s.target_kind].safeParse(payload)
  if (!parsed.success) {
    throw new ApplyError('invalid', `patch invalid: ${parsed.error.issues[0]?.message ?? ''}`)
  }
  const patch = parsed.data as Record<string, unknown>
  if (s.target_id === null) throw new ApplyError('invalid', 'update without a target')
  const current = getEntity(db, s.target_kind, s.owner_id, s.target_id)
  if (!current) throw new ApplyError('not_found', `${s.target_kind} ${s.target_id} not found`)
  if (current.state !== 'active') throw new ApplyError('conflict', `${s.target_kind} was deleted`)

  if (s.target_kind === 'task' && patch.status === 'done') {
    if (current.status !== 'todo' && current.status !== 'in_progress') {
      throw new ApplyError('conflict', `task is already ${String(current.status)}`)
    }
  }
  const changed = Object.keys(patch).filter((k) => !sameValue(current[k], patch[k]))
  if (changed.length === 0) throw new ApplyError('conflict', 'nothing left to change')

  // The merged result must still be a valid entity (e.g. an event cannot end before it starts).
  const merged = { ...current, ...patch }
  const check =
    s.target_kind === 'task'
      ? taskSelectSchema.safeParse(merged)
      : s.target_kind === 'event'
        ? eventSelectSchema.safeParse(merged)
        : { success: true as const }
  if (!check.success) throw new ApplyError('invalid', 'the change would make it invalid')

  const before: Record<string, unknown> = {}
  const after: Record<string, unknown> = {}
  for (const k of changed) {
    before[k] = current[k] ?? null
    after[k] = patch[k]
  }
  patchEntity(db, s.target_kind, s.owner_id, s.target_id, after, now)
  return { entityId: s.target_id, before, after }
}

export interface ApplyOptions {
  /** The user's edited payload (accept-with-edits → status `edited`). */
  payload?: Record<string, unknown>
  /** True when the server applies it on its own (tier `auto`). */
  auto?: boolean
}

/**
 * The pending readings that wait on a proposed tracker (`payload.tracker_id` is the tracker
 * suggestion's id, which becomes the tracker's id when it is created).
 */
function dependentReadings(db: Db, tracker: SuggestionRow): SuggestionRow[] {
  if (tracker.target_kind !== 'tracker' || tracker.operation !== 'create') return []
  return db
    .select()
    .from(suggestions)
    .where(
      and(
        eq(suggestions.owner_id, tracker.owner_id),
        eq(suggestions.source_bullet_id, tracker.source_bullet_id),
        eq(suggestions.target_kind, 'tracker_entry'),
        eq(suggestions.operation, 'create'),
        eq(suggestions.state, 'active'),
      ),
    )
    .all()
    .filter((r) => r.payload.tracker_id === tracker.id)
}

/**
 * Apply a pending suggestion against current state and mark it accepted (or `edited`). An
 * already-applied suggestion is returned unchanged (idempotent).
 *
 * Accepting a new tracker ("Start tracking Sleep?") also logs the readings that waited on it: the
 * user's yes covers the reading they gave in the same capture. One that no longer fits (the user
 * changed the scale while accepting) stays waiting for its own decision.
 */
export function applySuggestion(
  db: Db,
  s: SuggestionRow,
  now: number,
  opts: ApplyOptions = {},
): SuggestionRow {
  const applied = applyOne(db, s, now, opts)
  if (applied !== s) {
    for (const r of dependentReadings(db, applied)) {
      if (r.status !== 'pending') continue
      try {
        applyOne(db, r, now, {})
      } catch (err) {
        if (!(err instanceof ApplyError)) throw err
      }
    }
  }
  return applied
}

function applyOne(db: Db, s: SuggestionRow, now: number, opts: ApplyOptions = {}): SuggestionRow {
  if (s.applied_entity_id !== null && (s.status === 'accepted' || s.status === 'edited')) return s
  if (s.state !== 'active') throw new ApplyError('invalid', 'suggestion was withdrawn')
  if (s.status !== 'pending') throw new ApplyError('invalid', `suggestion is ${s.status}`)

  const edited = opts.payload !== undefined && !sameValue(opts.payload, s.payload)
  const payload = opts.payload ?? s.payload
  const result =
    s.operation === 'update' ? applyUpdate(db, s, payload, now) : applyCreate(db, s, payload, now)

  return updateSuggestionRow(
    db,
    s,
    {
      status: edited ? 'edited' : 'accepted',
      payload,
      resolved_at: now,
      applied_entity_id: result.entityId,
      applied_at: now,
      auto_applied: opts.auto === true,
      applied_before: result.before,
      applied_after: result.after,
    },
    now,
  )
}

/** Dismiss a pending suggestion. "Not now" on a new tracker also dismisses its waiting readings. */
export function rejectSuggestion(db: Db, s: SuggestionRow, now: number): SuggestionRow {
  if (s.status === 'rejected') return s
  if (s.status !== 'pending') throw new ApplyError('invalid', `suggestion is ${s.status}`)
  const rejected = updateSuggestionRow(db, s, { status: 'rejected', resolved_at: now }, now)
  for (const r of dependentReadings(db, s)) {
    if (r.status === 'pending')
      updateSuggestionRow(db, r, { status: 'rejected', resolved_at: now }, now)
  }
  return rejected
}

/**
 * Revert an applied suggestion → `rejected`. Refuses (`conflict`) when the affected entity was
 * changed after the apply, so undo never overwrites the user's own edits.
 */
export function undoSuggestion(db: Db, s: SuggestionRow, now: number): SuggestionRow {
  if (s.applied_entity_id === null || s.applied_at === null) {
    throw new ApplyError('invalid', 'suggestion is not applied')
  }
  // Undoing a new tracker takes the readings logged with it along (unless changed by hand).
  for (const r of dependentReadings(db, s)) {
    if (r.applied_entity_id === null) continue
    try {
      undoSuggestion(db, r, now)
    } catch (err) {
      if (!(err instanceof ApplyError)) throw err
    }
  }
  const entity = getEntity(db, s.target_kind, s.owner_id, s.applied_entity_id)
  // Changed (or deleted) by hand since it was applied: the user's version stays.
  if (
    entity &&
    typeof entity.user_edited_at === 'number' &&
    entity.user_edited_at >= s.applied_at
  ) {
    throw new ApplyError('conflict', `${s.target_kind} was edited by you since; not undone`)
  }
  if (s.operation === 'update') {
    if (entity) {
      for (const [k, v] of Object.entries(s.applied_after ?? {})) {
        if (!sameValue(entity[k], v)) {
          throw new ApplyError('conflict', `${s.target_kind} was changed since; not undone`)
        }
      }
      patchEntity(db, s.target_kind, s.owner_id, entity.id, s.applied_before ?? {}, now)
    }
  } else if (entity && entity.state === 'active') {
    if (entity.updated_at > s.applied_at) {
      throw new ApplyError('conflict', `${s.target_kind} was changed since; not undone`)
    }
    softDeleteEntity(db, s.target_kind, s.owner_id, entity.id, now)
  }
  return updateSuggestionRow(
    db,
    s,
    {
      status: 'rejected',
      resolved_at: now,
      applied_entity_id: null,
      applied_at: null,
      applied_before: null,
      applied_after: null,
    },
    now,
  )
}

/**
 * Keep a processed bullet's status honest after a review action: `needs_review` while any of its
 * suggestions is pending, otherwise `processed`. Bullets not yet processed are left alone.
 */
export function refreshReviewStatus(db: Db, ownerId: string, bulletId: string, now: number): void {
  const b = db
    .select()
    .from(bullets)
    .where(and(eq(bullets.id, bulletId), eq(bullets.owner_id, ownerId)))
    .get()
  if (!b || (b.proc_status !== 'processed' && b.proc_status !== 'needs_review')) return
  const pending = db
    .select({ id: suggestions.id })
    .from(suggestions)
    .where(
      and(
        eq(suggestions.source_bullet_id, bulletId),
        eq(suggestions.state, 'active'),
        eq(suggestions.status, 'pending'),
      ),
    )
    .get()
  const next = pending ? 'needs_review' : 'processed'
  if (next === b.proc_status) return
  db.update(bullets)
    .set({ proc_status: next, proc_updated_at: now, updated_at: now })
    .where(eq(bullets.id, bulletId))
    .run()
  touch(db, ownerId, 'bullets', bulletId)
}
