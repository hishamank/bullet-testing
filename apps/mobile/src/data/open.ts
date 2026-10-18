/** Device edge: open the on-device database (expo-sqlite) and run pending migrations. */

import { drizzle } from 'drizzle-orm/expo-sqlite'
import { addDatabaseChangeListener, openDatabaseSync } from 'expo-sqlite'
import { migrate, type PhoneDb } from './db'
import { schema } from './schema'

let instance: PhoneDb | null = null

/**
 * The app's single database connection, migrated on first use. Opened with the change listener
 * on, so `onDataChanged` hears every row write.
 */
export function getDb(): PhoneDb {
  if (!instance) {
    const sqlite = openDatabaseSync('bullet.db', { enableChangeListener: true })
    sqlite.execSync('PRAGMA journal_mode = WAL')
    const db = drizzle(sqlite, { schema })
    migrate(db)
    instance = db
  }
  return instance
}

/** Bookkeeping tables whose writes never change what a screen shows. */
const QUIET_TABLES = new Set(['sync_state', '__drizzle_migrations'])

/**
 * Hear every row the app's database writes (one call per row: coalesce before refreshing).
 * Returns an unsubscribe function.
 */
export function onDataChanged(listener: (table: string) => void): () => void {
  getDb()
  const sub = addDatabaseChangeListener((e) => {
    if (!QUIET_TABLES.has(e.tableName)) listener(e.tableName)
  })
  return () => sub.remove()
}
