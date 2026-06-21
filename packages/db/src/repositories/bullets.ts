/**
 * Bullets repository. Bullets are owner-scoped and soft-deletable; they have no
 * `source_bullet_id` (a bullet IS the provenance anchor).
 */

import { type Bullet, bulletInsertSchema } from '@bullet/core'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../client'
import { bullets } from '../schema'
import { type ListOptions, newId, now, parseInsert } from './shared'

export function createBullet(db: Db, input: unknown): Bullet {
  const parsed = parseInsert(bulletInsertSchema, input)
  const ts = now()
  const row: Bullet = {
    id: parsed.id ?? newId(),
    owner_id: parsed.owner_id,
    text: parsed.text,
    created_at: parsed.created_at ?? ts,
    updated_at: parsed.updated_at ?? ts,
    state: parsed.state ?? 'active',
  }
  db.insert(bullets).values(row).run()
  return row
}

export function getBulletById(db: Db, id: string): Bullet | undefined {
  return db.select().from(bullets).where(eq(bullets.id, id)).get()
}

/** List a user's bullets. Excludes soft-deleted rows unless `includeDeleted` is set. */
export function listBullets(db: Db, ownerId: string, opts: ListOptions = {}): Bullet[] {
  const where = opts.includeDeleted
    ? eq(bullets.owner_id, ownerId)
    : and(eq(bullets.owner_id, ownerId), eq(bullets.state, 'active'))
  return db.select().from(bullets).where(where).all()
}

/** Mutable fields on a bullet (never id/owner/created_at). Editing text re-runs extraction. */
export type BulletUpdate = Partial<Pick<Bullet, 'text' | 'state'>>

export function updateBullet(db: Db, id: string, patch: BulletUpdate): Bullet | undefined {
  db.update(bullets)
    .set({ ...patch, updated_at: now() })
    .where(eq(bullets.id, id))
    .run()
  return getBulletById(db, id)
}

export function softDeleteBullet(db: Db, id: string): Bullet | undefined {
  return updateBullet(db, id, { state: 'deleted' })
}
