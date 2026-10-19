/**
 * The phone database type and its migration runner — driver-agnostic, so the SAME code runs on
 * expo-sqlite (device), better-sqlite3 (Vitest) and, later, a browser SQLite (web).
 */

import { sql } from 'drizzle-orm'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import { MIGRATIONS } from './migrations.gen'
import type { schema } from './schema'

/** Any synchronous Drizzle SQLite handle (or transaction) over the phone schema. */
// oxlint-disable-next-line no-explicit-any -- the run-result type differs per driver and is unused
export type PhoneDb = BaseSQLiteDatabase<'sync', any, typeof schema>

/**
 * Apply pending migrations in order, each in its own transaction, recording applied tags in
 * `__migrations`. Safe to call on every app start.
 */
export function migrate(db: PhoneDb, migrations = MIGRATIONS): number {
  db.run(
    sql`CREATE TABLE IF NOT EXISTS __migrations (tag TEXT PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL)`,
  )
  const applied = new Set(
    db.all<{ tag: string }>(sql`SELECT tag FROM __migrations`).map((r) => r.tag),
  )
  let count = 0
  for (const m of migrations) {
    if (applied.has(m.tag)) continue
    db.transaction((tx) => {
      for (const stmt of m.sql.split('--> statement-breakpoint')) {
        if (stmt.trim()) tx.run(sql.raw(stmt))
      }
      tx.run(sql`INSERT INTO __migrations (tag, applied_at) VALUES (${m.tag}, ${Date.now()})`)
    })
    count += 1
  }
  return count
}
