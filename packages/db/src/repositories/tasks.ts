/**
 * Tasks repository.
 */

import { type Task, taskInsertSchema } from '@bullet/core'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../client'
import { tasks } from '../schema'
import { type ListOptions, now, parseInsert, withInsertDefaults } from './shared'

export function createTask(db: Db, input: unknown): Task {
  const row: Task = withInsertDefaults(parseInsert(taskInsertSchema, input))
  db.insert(tasks).values(row).run()
  return row
}

export function getTaskById(db: Db, id: string): Task | undefined {
  return db.select().from(tasks).where(eq(tasks.id, id)).get()
}

export function listTasks(db: Db, ownerId: string, opts: ListOptions = {}): Task[] {
  const where = opts.includeDeleted
    ? eq(tasks.owner_id, ownerId)
    : and(eq(tasks.owner_id, ownerId), eq(tasks.state, 'active'))
  return db.select().from(tasks).where(where).all()
}

/** List the ACTIVE tasks traced directly to one bullet (for the cascade soft-delete). */
export function listTasksBySourceBullet(db: Db, bulletId: string): Task[] {
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.source_bullet_id, bulletId), eq(tasks.state, 'active')))
    .all()
}

/** Mutable task fields (never id/owner/provenance/created_at). */
export type TaskUpdate = Partial<Pick<Task, 'status' | 'title' | 'notes' | 'due_at' | 'priority'>>

export function updateTask(db: Db, id: string, patch: TaskUpdate): Task | undefined {
  db.update(tasks)
    .set({ ...patch, updated_at: now() })
    .where(eq(tasks.id, id))
    .run()
  return getTaskById(db, id)
}

export function softDeleteTask(db: Db, id: string): Task | undefined {
  db.update(tasks).set({ state: 'deleted', updated_at: now() }).where(eq(tasks.id, id)).run()
  return getTaskById(db, id)
}
