/**
 * Tasks repository.
 */

import { type Task, taskInsertSchema } from '@bullet/core'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../client'
import { tasks } from '../schema'
import { type ListOptions, newId, now, parseInsert } from './shared'

export function createTask(db: Db, input: unknown): Task {
  const parsed = parseInsert(taskInsertSchema, input)
  const ts = now()
  const row: Task = {
    id: parsed.id ?? newId(),
    owner_id: parsed.owner_id,
    source_bullet_id: parsed.source_bullet_id,
    status: parsed.status,
    title: parsed.title,
    notes: parsed.notes,
    due_at: parsed.due_at,
    priority: parsed.priority,
    created_at: parsed.created_at ?? ts,
    updated_at: parsed.updated_at ?? ts,
    state: parsed.state ?? 'active',
  }
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
