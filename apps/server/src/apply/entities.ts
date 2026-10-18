/**
 * Generic persistence for the extracted entity kinds (task, event, tracker, tracker_entry,
 * activity). Every write stamps `updated_at` and records a sync change, so nothing written here
 * can be missed by a pull.
 */

import type { PullChangeKind, TargetKind } from '@bullet/core'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { activities, events, tasks, trackerEntries, trackers } from '../db/schema'
import { touch } from '../sync/changes'

const TABLES = {
  task: tasks,
  event: events,
  tracker: trackers,
  tracker_entry: trackerEntries,
  activity: activities,
} as const satisfies Record<TargetKind, unknown>

export const CHANGE_KIND = {
  task: 'tasks',
  event: 'events',
  tracker: 'trackers',
  tracker_entry: 'tracker_entries',
  activity: 'activities',
} as const satisfies Record<TargetKind, PullChangeKind>

/**
 * The kinds share `id`/`owner_id`/`state`/`updated_at`/`source_bullet_id` columns; the generic
 * operations below only touch those plus caller-validated fields, so one table type stands in for
 * all of them. Field sets are validated against `@bullet/core` schemas before reaching here.
 */
type EntityTable = typeof tasks
const tableFor = (kind: TargetKind): EntityTable => TABLES[kind] as unknown as EntityTable

export type EntityRow = Record<string, unknown> & {
  id: string
  owner_id: string
  state: 'active' | 'deleted'
  updated_at: number
  source_bullet_id: string | null
}

export function getEntity(
  db: Db,
  kind: TargetKind,
  ownerId: string,
  id: string,
): EntityRow | undefined {
  const t = tableFor(kind)
  return db
    .select()
    .from(t)
    .where(and(eq(t.id, id), eq(t.owner_id, ownerId)))
    .get() as EntityRow | undefined
}

/**
 * Insert a new entity with a caller-chosen id. Idempotent: inserting an id that already exists is
 * a no-op (returns false), which is what makes applying a suggestion safe to repeat.
 */
export function insertEntity(
  db: Db,
  kind: TargetKind,
  row: Record<string, unknown> & { id: string; owner_id: string },
  now: number,
): boolean {
  const t = tableFor(kind)
  const values = { ...row, created_at: now, updated_at: now, state: 'active' as const }
  const res = db
    .insert(t)
    .values(values as typeof t.$inferInsert)
    .onConflictDoNothing()
    .run()
  if (res.changes > 0) touch(db, row.owner_id, CHANGE_KIND[kind], row.id)
  return res.changes > 0
}

/** Write exactly the given fields (a field-level patch) and nothing else. */
export function patchEntity(
  db: Db,
  kind: TargetKind,
  ownerId: string,
  id: string,
  patch: Record<string, unknown>,
  now: number,
): void {
  const t = tableFor(kind)
  db.update(t)
    .set({ ...patch, updated_at: now } as Partial<typeof t.$inferInsert>)
    .where(and(eq(t.id, id), eq(t.owner_id, ownerId)))
    .run()
  touch(db, ownerId, CHANGE_KIND[kind], id)
}

export function softDeleteEntity(
  db: Db,
  kind: TargetKind,
  ownerId: string,
  id: string,
  now: number,
): void {
  patchEntity(db, kind, ownerId, id, { state: 'deleted' }, now)
}

/** Active entities of `kind` extracted from `bulletId`. */
export function listActiveBySource(
  db: Db,
  kind: TargetKind,
  ownerId: string,
  bulletId: string,
): EntityRow[] {
  const t = tableFor(kind)
  return db
    .select()
    .from(t)
    .where(and(eq(t.owner_id, ownerId), eq(t.source_bullet_id, bulletId), eq(t.state, 'active')))
    .all() as EntityRow[]
}

export const ENTITY_KINDS = Object.keys(TABLES) as TargetKind[]
