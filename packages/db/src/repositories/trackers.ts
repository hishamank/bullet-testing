/**
 * Trackers repository. A Tracker is a definition (created once, then logged against).
 */

import { type Tracker, trackerInsertSchema } from '@bullet/core'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../client'
import { trackers } from '../schema'
import { type ListOptions, now, parseInsert, withInsertDefaults } from './shared'

export function createTracker(db: Db, input: unknown): Tracker {
  const row: Tracker = withInsertDefaults(parseInsert(trackerInsertSchema, input))
  db.insert(trackers).values(row).run()
  return row
}

export function getTrackerById(db: Db, id: string): Tracker | undefined {
  return db.select().from(trackers).where(eq(trackers.id, id)).get()
}

export function listTrackers(db: Db, ownerId: string, opts: ListOptions = {}): Tracker[] {
  const where = opts.includeDeleted
    ? eq(trackers.owner_id, ownerId)
    : and(eq(trackers.owner_id, ownerId), eq(trackers.state, 'active'))
  return db.select().from(trackers).where(where).all()
}

/** List the ACTIVE trackers traced directly to one bullet (for the cascade soft-delete). */
export function listTrackersBySourceBullet(db: Db, bulletId: string): Tracker[] {
  return db
    .select()
    .from(trackers)
    .where(and(eq(trackers.source_bullet_id, bulletId), eq(trackers.state, 'active')))
    .all()
}

/** Mutable tracker fields. `input_type`/`config` move together (the two must stay coherent). */
export type TrackerUpdate = Partial<Pick<Tracker, 'name' | 'input_type' | 'config'>>

export function updateTracker(db: Db, id: string, patch: TrackerUpdate): Tracker | undefined {
  db.update(trackers)
    .set({ ...patch, updated_at: now() })
    .where(eq(trackers.id, id))
    .run()
  return getTrackerById(db, id)
}

export function softDeleteTracker(db: Db, id: string): Tracker | undefined {
  db.update(trackers).set({ state: 'deleted', updated_at: now() }).where(eq(trackers.id, id)).run()
  return getTrackerById(db, id)
}
