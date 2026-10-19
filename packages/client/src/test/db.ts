/** Vitest-only: the phone schema on an in-memory better-sqlite3 database, migrated like on device. */

import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate, type PhoneDb } from '../data/db'
import type { LocalDeps } from '../data/local'
import { schema } from '../data/schema'

export function openTestDb(): PhoneDb {
  const db = drizzle(new Database(':memory:'), { schema })
  migrate(db)
  return db
}

// Thursday 2026-10-15 09:12 in Paris.
export const T0 = Date.UTC(2026, 9, 15, 7, 12)

export function testDeps(clock = { now: T0 }): LocalDeps & { clock: { now: number } } {
  return { clock, now: () => clock.now, uuid: () => randomUUID(), timezone: () => 'Europe/Paris' }
}
