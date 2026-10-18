/**
 * Light manual editing (slice 1): the user changes or deletes a task, event or tracker reading by
 * hand. Patches are field-level (only what changed is written) and revalidated against current
 * state. Every manual write stamps `user_edited_at`, which is what makes undo and reprocessing
 * leave the row alone afterwards (see `undoSuggestion`).
 */

import {
  type EventManualPatch,
  eventSelectSchema,
  type TaskManualPatch,
  type TrackerEntryManualPatch,
  taskSelectSchema,
} from '@bullet/core'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { trackers } from '../db/schema'
import { ApplyError, entryValueFits } from './apply'
import { getEntity, patchEntity } from './entities'

export type ManualKind = 'task' | 'event' | 'tracker_entry'

export type ManualPatch<K extends ManualKind> = K extends 'task'
  ? TaskManualPatch
  : K extends 'event'
    ? EventManualPatch
    : TrackerEntryManualPatch

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function activeEntity(db: Db, kind: ManualKind, ownerId: string, id: string) {
  const current = getEntity(db, kind, ownerId, id)
  if (!current) throw new ApplyError('not_found', `${kind} ${id} not found`)
  if (current.state !== 'active') throw new ApplyError('invalid', `${kind} was deleted`)
  return current
}

/** Apply the user's patch. A patch that changes nothing writes nothing (safe to repeat). */
export function editByHand<K extends ManualKind>(
  db: Db,
  kind: K,
  ownerId: string,
  id: string,
  patch: ManualPatch<K>,
  now: number,
): void {
  const current = activeEntity(db, kind, ownerId, id)
  const fields = patch as Record<string, unknown>
  const changed = Object.fromEntries(
    Object.entries(fields).filter(([k, v]) => !same(current[k], v)),
  )
  if (Object.keys(changed).length === 0) return

  if (kind === 'tracker_entry') {
    const tracker = db
      .select()
      .from(trackers)
      .where(and(eq(trackers.id, String(current.tracker_id)), eq(trackers.owner_id, ownerId)))
      .get()
    if (!tracker) throw new ApplyError('not_found', 'tracker not found')
    if (!entryValueFits((patch as TrackerEntryManualPatch).value, tracker.config)) {
      throw new ApplyError('invalid', `value does not fit tracker "${tracker.name}"`)
    }
  }
  // The edited row must still be valid (e.g. an event cannot end before it starts).
  const merged = { ...current, ...changed }
  const check =
    kind === 'task'
      ? taskSelectSchema.safeParse(merged)
      : kind === 'event'
        ? eventSelectSchema.safeParse(merged)
        : { success: true as const }
  if (!check.success) throw new ApplyError('invalid', 'the change would make it invalid')

  patchEntity(db, kind, ownerId, id, { ...changed, user_edited_at: now }, now)
}

/** Soft-delete by hand. Deleting something already deleted is a no-op. */
export function deleteByHand(
  db: Db,
  kind: ManualKind,
  ownerId: string,
  id: string,
  now: number,
): void {
  const current = getEntity(db, kind, ownerId, id)
  if (!current) throw new ApplyError('not_found', `${kind} ${id} not found`)
  if (current.state === 'deleted') return
  patchEntity(db, kind, ownerId, id, { state: 'deleted', user_edited_at: now }, now)
}
