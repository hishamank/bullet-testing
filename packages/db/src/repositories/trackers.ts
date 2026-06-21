/**
 * Trackers repository. A Tracker is a definition (created once, then logged against).
 */

import { type Tracker, trackerInsertSchema } from '@bullet/core'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../client'
import { trackers } from '../schema'
import { type ListOptions, newId, now, parseInsert } from './shared'

export function createTracker(db: Db, input: unknown): Tracker {
  const parsed = parseInsert(trackerInsertSchema, input)
  const ts = now()
  const row: Tracker = {
    id: parsed.id ?? newId(),
    owner_id: parsed.owner_id,
    source_bullet_id: parsed.source_bullet_id,
    name: parsed.name,
    input_type: parsed.input_type,
    config: parsed.config,
    created_at: parsed.created_at ?? ts,
    updated_at: parsed.updated_at ?? ts,
    state: parsed.state ?? 'active',
  }
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
