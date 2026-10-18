/**
 * Opening the server database: better-sqlite3 wrapped by Drizzle, migrated on open.
 *
 * Why better-sqlite3 (not node:sqlite): Drizzle's stable release supports it first-class (its
 * node:sqlite driver is only in the 1.0 RC), it is mature, and its SYNCHRONOUS transactions make
 * "reconcile + apply + status change" trivially atomic — no await can interleave another write.
 * The cost is a native addon, built once at install.
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import type { RunResult } from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import { schema } from './schema'

/**
 * The Drizzle handle, typed as the synchronous base so the SAME type describes a transaction —
 * every domain function accepts either the connection or a `tx`.
 */
export type Db = BaseSQLiteDatabase<'sync', RunResult, typeof schema>

export const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url))

export interface DbConnection {
  db: Db
  close: () => void
}

/** Open (creating if needed) and migrate the database at `path` (`:memory:` for tests). */
export function openDb(path: string): DbConnection {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const sqlite = new Database(path)
  sqlite.pragma('foreign_keys = ON')
  if (path !== ':memory:') sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('busy_timeout = 5000')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder })
  return { db, close: () => sqlite.close() }
}
