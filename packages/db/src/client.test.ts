import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createDb, createTestDb, runMigrations } from './client'
import { createUser } from './repositories/users'
import { users } from './schema'

const TABLES = [
  'users',
  'bullets',
  'tasks',
  'trackers',
  'tracker_entries',
  'activities',
  'suggestions',
  'jobs',
]

function tableNames(sqlite: import('./client').Sqlite): string[] {
  const rows = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>
  return rows.map((r) => r.name)
}

test('migrations apply to a fresh in-memory db (all tables exist)', () => {
  const { sqlite } = createTestDb()
  const names = tableNames(sqlite)
  for (const t of TABLES) {
    expect(names).toContain(t)
  }
  sqlite.close()
})

test('foreign_keys pragma is ON', () => {
  const { sqlite } = createTestDb()
  const rows = sqlite.pragma('foreign_keys') as Array<{ foreign_keys: number }>
  expect(rows[0]?.foreign_keys).toBe(1)
  sqlite.close()
})

test('runMigrations is idempotent on an already-migrated db', () => {
  const { db, sqlite } = createTestDb()
  // Re-running migrations must not throw or duplicate tables.
  expect(() => runMigrations(db)).not.toThrow()
  expect(tableNames(sqlite)).toContain('users')
  sqlite.close()
})

// --- Real temp file (proves the generated SQL is valid against on-disk SQLite). ---
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bullet-db-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('migrations apply to a real temp file and survive reopen', () => {
  const file = join(dir, 'test.db')

  const first = createDb(file, { migrate: true })
  const user = createUser(first.db, { name: 'Persisted' })
  first.sqlite.close()

  // Reopen the SAME file without migrating; the row and schema must still be there.
  const second = createDb(file)
  const names = tableNames(second.sqlite)
  expect(names).toContain('suggestions')
  const found = second.db.select().from(users).all() as Array<{
    id: string
    name: string | null
  }>
  expect(found.some((u) => u.id === user.id && u.name === 'Persisted')).toBe(true)
  second.sqlite.close()
})
