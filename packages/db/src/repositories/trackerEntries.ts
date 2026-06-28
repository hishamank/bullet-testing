/**
 * TrackerEntries repository. A TrackerEntry is a record logged against a Tracker.
 */

import { type TrackerEntry, trackerEntryInsertSchema } from '@bullet/core'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../client'
import { trackerEntries } from '../schema'
import { type ListOptions, now, parseInsert, withInsertDefaults } from './shared'

export function createTrackerEntry(db: Db, input: unknown): TrackerEntry {
  const row: TrackerEntry = withInsertDefaults(parseInsert(trackerEntryInsertSchema, input))
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
