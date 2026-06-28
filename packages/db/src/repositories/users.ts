/**
 * Users repository. The owner root has no `owner_id` and no soft-delete `state` (it is the
 * anchor every other entity points at), so its API is a small subset: create/getById/list/
 * update. (No `softDelete` — deleting the owner is out of scope for v1.)
 */

import { type User, userInsertSchema } from '@bullet/core'
import { eq } from 'drizzle-orm'
import type { Db } from '../client'
import { users } from '../schema'
import { newId, now, parseInsert } from './shared'

export function createUser(db: Db, input: unknown): User {
  const parsed = parseInsert(userInsertSchema, input)
  const ts = now()
  const row = {
    id: parsed.id ?? newId(),
    name: parsed.name,
    created_at: parsed.created_at ?? ts,
    updated_at: parsed.updated_at ?? ts,
  }
  db.insert(users).values(row).run()
  return row
}

export function getUserById(db: Db, id: string): User | undefined {
  return db.select().from(users).where(eq(users.id, id)).get()
}

export function listUsers(db: Db): User[] {
  return db.select().from(users).all()
}

/** Fields a caller may change on a user (never id/created_at). */
export type UserUpdate = Partial<Pick<User, 'name'>>

export function updateUser(db: Db, id: string, patch: UserUpdate): User | undefined {
  db.update(users)
    .set({ ...patch, updated_at: now() })
    .where(eq(users.id, id))
    .run()
  return getUserById(db, id)
}
