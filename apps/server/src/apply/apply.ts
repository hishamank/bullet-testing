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
  isThingKind,
  type ThingKind,
  type PushRejectCode,
  type TrackerEntryValue,
  targetKindInsertSchemas,
  targetKindUpdateSchemas,
  thoughtResolvePayloadSchema,
  taskSelectSchema,
  eventSelectSchema,
} from '@bullet/core'
import { readingAsActivity, yesNoAnswer } from '@bullet/engine'
import { and, eq, ne, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { bullets, questions, suggestions, thoughts, trackerEntries, trackers } from '../db/schema'
import { linkBetween, setLinkType, vetoPair } from '../connections/store'
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

/** The thing a suggestion is about (a `thought_resolve` is handled on its own, never here). */
function thingKindOf(s: SuggestionRow): ThingKind {
  if (!isThingKind(s.target_kind))
    throw new ApplyError('invalid', `${s.target_kind} is not a thing`)
  return s.target_kind
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
    // A tracker of that name exists (another capture's offer was accepted first, maybe on another
    // phone): this offer is linked to it rather than refused or duplicated.
    if (dup) return { entityId: dup.id, before: null, after: { [LINKED_TO]: dup.id } }
  }

  insertEntity(db, thingKindOf(s), { ...data, id: s.id, owner_id: s.owner_id }, now)
  return { entityId: s.id, before: null, after: null }
}

/** `applied_after` key marking a tracker offer resolved by linking it to an existing tracker. */
const LINKED_TO = 'linked_to'

/** The existing tracker a tracker offer was linked to (it created nothing), if it was. */
function linkedTracker(s: SuggestionRow): string | null {
  const v = s.applied_after?.[LINKED_TO]
  return typeof v === 'string' ? v : null
}

/** A waiting reading of a linked offer becomes an ordinary reading of that tracker. */
function repointReading(db: Db, r: SuggestionRow, trackerId: string, now: number): void {
  updateSuggestionRow(db, r, { payload: { ...r.payload, tracker_id: trackerId } }, now)
}

/**
 * Resolve another capture's still-open offer for a tracker that now exists: it is linked to that
 * tracker (accepted, creating nothing), its "Start tracking …?" question is answered, and its
 * readings wait as ordinary readings of the tracker ("Log 7 h to Sleep?"), one per capture.
 */
function linkOffer(db: Db, offer: SuggestionRow, trackerId: string, now: number): void {
  const readings = dependentReadings(db, offer)
  updateSuggestionRow(
    db,
    offer,
    {
      status: 'accepted',
      resolved_at: now,
      applied_entity_id: trackerId,
      applied_at: now,
      auto_applied: false,
      applied_before: null,
      applied_after: { [LINKED_TO]: trackerId },
    },
    now,
  )
  for (const r of readings) if (r.status === 'pending') repointReading(db, r, trackerId, now)
  settleTrackerQuestions(db, offer, true, now)
  refreshReviewStatus(db, offer.owner_id, offer.source_bullet_id, now)
}

/** Other captures' offers that were linked to this tracker (accepted, created nothing). */
function offersLinkedTo(db: Db, ownerId: string, trackerId: string): SuggestionRow[] {
  return db
    .select()
    .from(suggestions)
    .where(
      and(
        eq(suggestions.owner_id, ownerId),
        eq(suggestions.target_kind, 'tracker'),
        eq(suggestions.operation, 'create'),
        eq(suggestions.state, 'active'),
        eq(suggestions.applied_entity_id, trackerId),
      ),
    )
    .all()
    .filter((o) => linkedTracker(o) === trackerId)
}

/**
 * The tracker a linked offer pointed at is being undone: the offer is open again ("Start tracking
 * Sleep?"), its waiting readings wait on it again, and its question is asked again.
 */
function unlinkOffer(db: Db, offer: SuggestionRow, now: number): void {
  const trackerId = offer.applied_entity_id
  updateSuggestionRow(
    db,
    offer,
    {
      status: 'pending',
      resolved_at: null,
      applied_entity_id: null,
      applied_at: null,
      applied_before: null,
      applied_after: null,
    },
    now,
  )
  const readings = db
    .select()
    .from(suggestions)
    .where(
      and(
        eq(suggestions.owner_id, offer.owner_id),
        eq(suggestions.source_bullet_id, offer.source_bullet_id),
        eq(suggestions.target_kind, 'tracker_entry'),
        eq(suggestions.operation, 'create'),
        eq(suggestions.status, 'pending'),
        eq(suggestions.state, 'active'),
      ),
    )
    .all()
    .filter((r) => r.payload.tracker_id === trackerId)
  for (const r of readings) repointReading(db, r, offer.id, now)
  for (const q of db
    .select()
    .from(questions)
    .where(
      and(
        eq(questions.owner_id, offer.owner_id),
        eq(questions.suggestion_id, offer.id),
        eq(questions.topic, 'new_tracker'),
        eq(questions.status, 'answered'),
        eq(questions.state, 'active'),
      ),
    )
    .all()) {
    db.update(questions)
      .set({ status: 'open', answer_option: null, resolved_at: null, updated_at: now })
      .where(eq(questions.id, q.id))
      .run()
    touch(db, offer.owner_id, 'questions', q.id)
  }
  refreshReviewStatus(db, offer.owner_id, offer.source_bullet_id, now)
}

const normName = (v: unknown) =>
  typeof v === 'string' ? v.toLowerCase().trim().replace(/\s+/g, ' ') : ''

/** Other captures' open offers of a tracker with this name. */
function openOffersNamed(db: Db, ownerId: string, name: string, except: string): SuggestionRow[] {
  return db
    .select()
    .from(suggestions)
    .where(
      and(
        eq(suggestions.owner_id, ownerId),
        eq(suggestions.target_kind, 'tracker'),
        eq(suggestions.operation, 'create'),
        eq(suggestions.status, 'pending'),
        eq(suggestions.state, 'active'),
        ne(suggestions.id, except),
      ),
    )
    .all()
    .filter((o) => normName(o.payload.name) === normName(name))
}

/**
 * A new tracker decided from its Inbox card ("Start tracking" / "Not now") answers its "Start
 * tracking …?" question too, so it never lingers open.
 */
export function settleTrackerQuestions(db: Db, s: SuggestionRow, yes: boolean, now: number): void {
  if (s.target_kind !== 'tracker') return
  const open = db
    .select()
    .from(questions)
    .where(
      and(
        eq(questions.owner_id, s.owner_id),
        eq(questions.suggestion_id, s.id),
        eq(questions.topic, 'new_tracker'),
        eq(questions.status, 'open'),
        eq(questions.state, 'active'),
      ),
    )
    .all()
  for (const q of open) {
    const option = q.options.find((o) => yesNoAnswer(o) === yes) ?? null
    db.update(questions)
      .set({ status: 'answered', answer_option: option, resolved_at: now, updated_at: now })
      .where(eq(questions.id, q.id))
      .run()
    touch(db, s.owner_id, 'questions', q.id)
  }
}

/** Validate + revalidate a field-level update and write ONLY the patched fields. */
function applyUpdate(db: Db, s: SuggestionRow, payload: Record<string, unknown>, now: number) {
  const parsed = targetKindUpdateSchemas[s.target_kind].safeParse(payload)
  if (!parsed.success) {
    throw new ApplyError('invalid', `patch invalid: ${parsed.error.issues[0]?.message ?? ''}`)
  }
  const patch = parsed.data as Record<string, unknown>
  if (s.target_id === null) throw new ApplyError('invalid', 'update without a target')
  const kind = thingKindOf(s)
  const current = getEntity(db, kind, s.owner_id, s.target_id)
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
  patchEntity(db, kind, s.owner_id, s.target_id, after, now)
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
  const readings = dependentReadings(db, s)
  const applied = applyOne(db, s, now, opts)
  if (applied === s || applied.target_kind !== 'tracker' || applied.operation !== 'create') {
    return applied
  }
  const trackerId = applied.applied_entity_id as string
  if (linkedTracker(applied)) {
    // Linked to an existing tracker: its readings wait as ordinary readings of it.
    for (const r of readings) if (r.status === 'pending') repointReading(db, r, trackerId, now)
  } else {
    for (const r of readings) {
      if (r.status !== 'pending') continue
      try {
        applyOne(db, r, now, {})
      } catch (err) {
        if (!(err instanceof ApplyError)) throw err
      }
    }
  }
  // The tracker exists now: every other capture's open offer for it turns into its readings.
  for (const o of openOffersNamed(db, applied.owner_id, String(applied.payload.name), applied.id)) {
    linkOffer(db, o, trackerId, now)
  }
  return applied
}

function applyOne(db: Db, s: SuggestionRow, now: number, opts: ApplyOptions = {}): SuggestionRow {
  if (s.applied_entity_id !== null && (s.status === 'accepted' || s.status === 'edited')) return s
  if (s.state !== 'active') throw new ApplyError('invalid', 'suggestion was withdrawn')
  if (s.status !== 'pending') throw new ApplyError('invalid', `suggestion is ${s.status}`)
  if (s.target_kind === 'thought_resolve') return applyThoughtResolve(db, s, now)

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

// --- "Did this close it?" (thought_resolve, slice 3) ---

function loopOf(db: Db, s: SuggestionRow) {
  if (s.target_id === null) throw new ApplyError('invalid', 'thought_resolve without a target')
  const loop = db
    .select()
    .from(thoughts)
    .where(and(eq(thoughts.id, s.target_id), eq(thoughts.owner_id, s.owner_id)))
    .get()
  if (!loop) throw new ApplyError('not_found', `thought ${s.target_id} not found`)
  return loop
}

/**
 * Accept "Did this close it?": the open loop is resolved, recording the capture that answered it.
 * Refused (`conflict`) when the loop is gone, no longer an open loop, or already closed (by hand,
 * a note or another answer): the phone shows "Already closed". Never applied automatically.
 */
function applyThoughtResolve(db: Db, s: SuggestionRow, now: number): SuggestionRow {
  const parsed = thoughtResolvePayloadSchema.safeParse(s.payload)
  if (!parsed.success) throw new ApplyError('invalid', 'thought_resolve payload invalid')
  const loop = loopOf(db, s)
  if (loop.state !== 'active') throw new ApplyError('conflict', 'the thought was deleted')
  if (loop.kind !== 'to_check' && loop.kind !== 'question') {
    throw new ApplyError('conflict', 'the thought is no longer an open loop')
  }
  if (loop.resolved_at !== null) throw new ApplyError('conflict', 'already closed')
  const after = { resolved_at: now, resolved_by_bullet_id: parsed.data.resolved_by_bullet_id }
  db.update(thoughts)
    .set({ ...after, updated_at: now })
    .where(eq(thoughts.id, loop.id))
    .run()
  touch(db, s.owner_id, 'thoughts', loop.id)
  return updateSuggestionRow(
    db,
    s,
    {
      status: 'accepted',
      resolved_at: now,
      applied_entity_id: loop.id,
      applied_at: now,
      auto_applied: false,
      applied_before: { resolved_at: null, resolved_by_bullet_id: null },
      applied_after: after,
    },
    now,
  )
}

/**
 * Undo "Did this close it?": the loop opens again. Refused (`conflict`) when it was since closed
 * another way; already open again (re-opened by hand) just records the undo.
 */
function undoThoughtResolve(db: Db, s: SuggestionRow, now: number): SuggestionRow {
  const loop = loopOf(db, s)
  const after = s.applied_after ?? {}
  const ours =
    loop.resolved_at === after.resolved_at &&
    loop.resolved_by_bullet_id === after.resolved_by_bullet_id
  if (loop.resolved_at !== null && !ours) {
    throw new ApplyError('conflict', 'the loop was closed another way since; not undone')
  }
  if (ours) {
    db.update(thoughts)
      .set({ resolved_at: null, resolved_by_bullet_id: null, updated_at: now })
      .where(eq(thoughts.id, loop.id))
      .run()
    touch(db, s.owner_id, 'thoughts', loop.id)
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
 * Dismissing "Did this close it?" vetoes that pair for good, and the link between them is no
 * longer called an answer.
 */
function dismissThoughtResolve(db: Db, s: SuggestionRow, now: number): void {
  if (s.target_id === null || s.source_thought_id === null) return
  vetoPair(db, s.owner_id, s.target_id, s.source_thought_id, 'resolve', 'user', now)
  const link = linkBetween(db, s.owner_id, s.target_id, s.source_thought_id)
  if (link?.state === 'active' && link.type === 'answers') setLinkType(db, link, 'same_topic', now)
}

/**
 * Dismiss a pending suggestion. "Not now" on a new tracker keeps each reading that waited on it
 * as a plain activity with its value ("Slept · 6 h", no tracker), applied as a record: the
 * reading is never lost, and the declined offer never comes back (reconcile keeps it rejected).
 */
export function rejectSuggestion(db: Db, s: SuggestionRow, now: number): SuggestionRow {
  if (s.status === 'rejected') return s
  if (s.status !== 'pending') throw new ApplyError('invalid', `suggestion is ${s.status}`)
  const readings = dependentReadings(db, s)
  const rejected = updateSuggestionRow(db, s, { status: 'rejected', resolved_at: now }, now)
  if (s.target_kind === 'thought_resolve') dismissThoughtResolve(db, s, now)
  for (const r of readings) {
    if (r.status !== 'pending') continue
    keepReadingAsActivity(db, r, s, now)
  }
  return rejected
}

/** Turn a waiting reading of a declined tracker offer into an applied activity with its value. */
function keepReadingAsActivity(db: Db, r: SuggestionRow, offer: SuggestionRow, now: number): void {
  const activity = updateSuggestionRow(
    db,
    r,
    {
      target_kind: 'activity',
      operation: 'create',
      target_id: null,
      payload: readingAsActivity(r.payload, offer.payload),
    },
    now,
  )
  try {
    applyOne(db, activity, now, {})
  } catch (err) {
    if (!(err instanceof ApplyError)) throw err
  }
}

/**
 * Revert an applied suggestion → `rejected`. Refuses (`conflict`) when the affected entity was
 * changed after the apply, so undo never overwrites the user's own edits.
 */
export function undoSuggestion(db: Db, s: SuggestionRow, now: number): SuggestionRow {
  if (s.applied_entity_id === null || s.applied_at === null) {
    throw new ApplyError('invalid', 'suggestion is not applied')
  }
  if (s.target_kind === 'thought_resolve') return undoThoughtResolve(db, s, now)
  // A tracker offer linked to an existing tracker created nothing: undoing it never touches that
  // tracker (nor the readings now logged to it).
  if (linkedTracker(s)) {
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
  if (s.target_kind === 'tracker' && s.operation === 'create') {
    // Undoing a new tracker takes the readings logged with it along; refused when one was changed
    // by hand (it would be orphaned), or when the tracker has readings from elsewhere now.
    const own = dependentReadings(db, s).filter((r) => r.applied_entity_id !== null)
    for (const r of own) {
      const e = getEntity(db, 'tracker_entry', s.owner_id, r.applied_entity_id as string)
      if (e && typeof e.user_edited_at === 'number' && e.user_edited_at >= (r.applied_at ?? 0)) {
        throw new ApplyError('conflict', 'a reading logged with this tracker was edited by you')
      }
    }
    const ownIds = own.map((r) => r.applied_entity_id as string)
    const others = db
      .select({ id: trackerEntries.id })
      .from(trackerEntries)
      .where(
        and(
          eq(trackerEntries.owner_id, s.owner_id),
          eq(trackerEntries.tracker_id, s.applied_entity_id),
          eq(trackerEntries.state, 'active'),
        ),
      )
      .all()
      .filter((e) => !ownIds.includes(e.id))
    if (others.length > 0) {
      throw new ApplyError('conflict', 'the tracker has other readings now; not undone')
    }
    for (const r of own) undoSuggestion(db, r, now)
    for (const o of offersLinkedTo(db, s.owner_id, s.applied_entity_id)) unlinkOffer(db, o, now)
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
 * suggestions is pending, otherwise `processed`. Bullets not yet processed are left alone. A
 * waiting "Did this close it?" is about another capture's loop: it never holds a capture in
 * `needs_review`.
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
        ne(suggestions.target_kind, 'thought_resolve'),
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
