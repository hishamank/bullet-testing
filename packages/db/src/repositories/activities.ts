/**
 * Activities repository. An Activity is a record of something the user DID; it may optionally
 * link to a Tracker.
 */

import { type Activity, activityInsertSchema } from '@bullet/core'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../client'
import { activities } from '../schema'
import { type ListOptions, newId, now, parseInsert } from './shared'

export function createActivity(db: Db, input: unknown): Activity {
  const parsed = parseInsert(activityInsertSchema, input)
  const ts = now()
  const row: Activity = {
    id: parsed.id ?? newId(),
    owner_id: parsed.owner_id,
    source_bullet_id: parsed.source_bullet_id,
    name: parsed.name,
    occurred_at: parsed.occurred_at,
    tracker_id: parsed.tracker_id,
    notes: parsed.notes,
    quantity: parsed.quantity,
    unit: parsed.unit,
    created_at: parsed.created_at ?? ts,
    updated_at: parsed.updated_at ?? ts,
    state: parsed.state ?? 'active',
  }
  db.insert(activities).values(row).run()
  return row
}

export function getActivityById(db: Db, id: string): Activity | undefined {
  return db.select().from(activities).where(eq(activities.id, id)).get()
}

export function listActivities(db: Db, ownerId: string, opts: ListOptions = {}): Activity[] {
  const where = opts.includeDeleted
    ? eq(activities.owner_id, ownerId)
    : and(eq(activities.owner_id, ownerId), eq(activities.state, 'active'))
  return db.select().from(activities).where(where).all()
}

/** List the ACTIVE activities traced directly to one bullet (for the cascade soft-delete). */
export function listActivitiesBySourceBullet(db: Db, bulletId: string): Activity[] {
  return db
    .select()
    .from(activities)
    .where(and(eq(activities.source_bullet_id, bulletId), eq(activities.state, 'active')))
    .all()
}

/** Mutable activity fields (never id/owner/provenance/created_at). */
export type ActivityUpdate = Partial<
  Pick<Activity, 'name' | 'occurred_at' | 'tracker_id' | 'notes' | 'quantity' | 'unit'>
>

export function updateActivity(db: Db, id: string, patch: ActivityUpdate): Activity | undefined {
  db.update(activities)
    .set({ ...patch, updated_at: now() })
    .where(eq(activities.id, id))
    .run()
  return getActivityById(db, id)
}

export function softDeleteActivity(db: Db, id: string): Activity | undefined {
  db.update(activities)
    .set({ state: 'deleted', updated_at: now() })
    .where(eq(activities.id, id))
    .run()
  return getActivityById(db, id)
}
