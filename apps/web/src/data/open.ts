/**
 * Browser edge: open the in-browser mirror. sql.js (SQLite compiled to WebAssembly, served from
 * this app, no CDN) behind drizzle's sql-js driver, over the same `schema` and `migrate()` the
 * phone uses. The file image comes from, and is saved to, a `BlobStore` (IndexedDB).
 *
 * The mirror is a cache, but an image that cannot be read is backed up, never silently replaced.
 */

import { migrate, type PhoneDb, schema } from '@bullet/client'
import { drizzle } from 'drizzle-orm/sql-js'
import type { Database, SqlJsStatic } from 'sql.js'
import type { BlobStore } from './persist'

export interface Mirror {
  db: PhoneDb
  /** A copy of the database file as it is now (what gets persisted). */
  snapshot(): Uint8Array
  close(): void
  /** True when a saved image existed but could not be used and a fresh mirror took its place. */
  recovered: boolean
}

function create(sql: SqlJsStatic, bytes: Uint8Array | null): { raw: Database; db: PhoneDb } {
  const raw = bytes ? new sql.Database(bytes) : new sql.Database()
  const db = drizzle(raw, { schema }) as unknown as PhoneDb
  migrate(db)
  return { raw, db }
}

export interface OpenOptions {
  /** Start empty without reading the store (the mirror is being wiped on purpose). */
  fresh?: boolean
}

/**
 * Open the mirror from the stored image.
 *  - `store.load()` failing is thrown: never start empty because of a passing IndexedDB error,
 *    the next save would overwrite the real image (and its unsent changes).
 *  - Bytes that cannot be opened or migrated are copied to a backup first (a failing backup is
 *    thrown too), and only then is a fresh mirror started (`recovered`).
 */
export async function openMirror(
  sql: SqlJsStatic,
  store: BlobStore,
  opts: OpenOptions = {},
): Promise<Mirror> {
  const bytes = opts.fresh ? null : await store.load()
  let recovered = false
  let opened: { raw: Database; db: PhoneDb }
  try {
    opened = create(sql, bytes)
  } catch {
    if (bytes === null) throw new Error('could not start a new local copy')
    await store.backup(bytes)
    recovered = true
    opened = create(sql, null)
  }
  const { raw, db } = opened
  return {
    db,
    snapshot: () => raw.export(),
    close: () => raw.close(),
    recovered,
  }
}
