/**
 * Database client — opening, configuring, and migrating a SQLite database via better-sqlite3,
 * wrapped with Drizzle ORM. This is the only place the raw driver is touched.
 */

import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { schema } from './schema'

/** A better-sqlite3 database handle. */
export type Sqlite = Database.Database

/** The Drizzle database, typed with the full schema. */
export type Db = ReturnType<typeof drizzle<typeof schema>>

/** What `createDb` returns: the Drizzle wrapper plus the underlying raw handle. */
export interface DbConnection {
  db: Db
  sqlite: Sqlite
}

/**
 * The folder holding the generated Drizzle migration SQL. Resolved relative to THIS module,
 * so it works from both `src/` (vitest, via tsx/esbuild) and `dist/` (the built bundle):
 * `../drizzle` resolves to `packages/db/drizzle` from either location.
 */
export const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))

export interface CreateDbOptions {
  /** When true, apply all pending migrations immediately after opening. */
  migrate?: boolean
  /** Use SQLite WAL journal mode (recommended for file-backed dbs; ignored for `:memory:`). */
  wal?: boolean
}

/**
 * Open a SQLite database at `url` (accepts `':memory:'` or a file path), enforce
 * `PRAGMA foreign_keys = ON`, and wrap it with Drizzle. Optionally enables WAL and runs
 * migrations.
 */
export function createDb(url: string, opts: CreateDbOptions = {}): DbConnection {
  const sqlite = new Database(url)
  // Foreign keys are OFF by default in SQLite — turn them on so our FK references are enforced.
  sqlite.pragma('foreign_keys = ON')
  if (opts.wal && url !== ':memory:') {
    sqlite.pragma('journal_mode = WAL')
  }

  const db = drizzle(sqlite, { schema })

  if (opts.migrate) {
    migrate(db, { migrationsFolder })
  }

  return { db, sqlite }
}

/** Apply all pending migrations to an already-open Drizzle database. */
export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder })
}

/**
 * An in-memory database with migrations applied — the helper tests use. Returns the same
 * `{ db, sqlite }` shape as `createDb`.
 */
export function createTestDb(): DbConnection {
  return createDb(':memory:', { migrate: true })
}
