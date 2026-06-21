/**
 * TrackerEntries repository. A TrackerEntry is a record logged against a Tracker.
 */

import { type TrackerEntry, trackerEntryInsertSchema } from '@bullet/core'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../client'
import { trackerEntries } from '../schema'
import { type ListOptions, newId, now, parseInsert } from './shared'

export function createTrackerEntry(db: Db, input: unknown): TrackerEntry {
  const parsed = parseInsert(trackerEntryInsertSchema, input)
  const ts = now()
  const row: TrackerEntry = {
    id: parsed.id ?? newId(),
    owner_id: parsed.owner_id,
    source_bullet_id: parsed.source_bullet_id,
    tracker_id: parsed.tracker_id,
    value: parsed.value,
    logged_at: parsed.logged_at,
    created_at: parsed.created_at ?? ts,
    updated_at: parsed.updated_at ?? ts,
    state: parsed.state ?? 'active',
  }
  db.insert(trackerEntries).values(row).run()
  return row
}

export function getTrackerEntryById(db: Db, id: string): TrackerEntry | undefined {
  return db.select().from(trackerEntries).where(eq(trackerEntries.id, id)).get()
}

export function listTrackerEntries(
  db: Db,
  ownerId: string,
  opts: ListOptions = {},
): TrackerEntry[] {
  const where = opts.includeDeleted
    ? eq(trackerEntries.owner_id, ownerId)
    : and(eq(trackerEntries.owner_id, ownerId), eq(trackerEntries.state, 'active'))
  return db.select().from(trackerEntries).where(where).all()
}

/** List the ACTIVE tracker entries traced directly to one bullet (for the cascade soft-delete). */
export function listTrackerEntriesBySourceBullet(db: Db, bulletId: string): TrackerEntry[] {
  return db
    .select()
    .from(trackerEntries)
    .where(and(eq(trackerEntries.source_bullet_id, bulletId), eq(trackerEntries.state, 'active')))
    .all()
}

/** List the entries logged against one tracker (active only unless `includeDeleted`). */
export function listEntriesByTracker(
  db: Db,
  trackerId: string,
  opts: ListOptions = {},
): TrackerEntry[] {
  const where = opts.includeDeleted
    ? eq(trackerEntries.tracker_id, trackerId)
    : and(eq(trackerEntries.tracker_id, trackerId), eq(trackerEntries.state, 'active'))
  return db.select().from(trackerEntries).where(where).all()
}

/** Mutable tracker-entry fields (never id/owner/provenance/tracker_id/created_at). */
export type TrackerEntryUpdate = Partial<Pick<TrackerEntry, 'value' | 'logged_at'>>

export function updateTrackerEntry(
  db: Db,
  id: string,
  patch: TrackerEntryUpdate,
): TrackerEntry | undefined {
  db.update(trackerEntries)
    .set({ ...patch, updated_at: now() })
    .where(eq(trackerEntries.id, id))
    .run()
  return getTrackerEntryById(db, id)
}

export function softDeleteTrackerEntry(db: Db, id: string): TrackerEntry | undefined {
  db.update(trackerEntries)
    .set({ state: 'deleted', updated_at: now() })
    .where(eq(trackerEntries.id, id))
    .run()
  return getTrackerEntryById(db, id)
}
