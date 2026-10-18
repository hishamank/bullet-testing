/** Device edge: open the on-device database (expo-sqlite) and run pending migrations. */

import { drizzle } from 'drizzle-orm/expo-sqlite'
import { openDatabaseSync } from 'expo-sqlite'
import { migrate, type PhoneDb } from './db'
import { schema } from './schema'

let instance: PhoneDb | null = null

/**
 * The app's single database connection, migrated on first use. Opened with the change listener
 * on, so `addDatabaseChangeListener` (and Drizzle's live queries) see every write.
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
