/**
 * Browser edge: open the in-browser mirror. sql.js (SQLite compiled to WebAssembly, served from
 * this app, no CDN) behind drizzle's sql-js driver, over the same `schema` and `migrate()` the
 * phone uses. The file image comes from, and is saved to, a `BlobStore` (IndexedDB).
 *
 * The mirror is a cache: an image that cannot be read is dropped and the next full pull rebuilds
 * it.
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

export async function openMirror(sql: SqlJsStatic, store: BlobStore): Promise<Mirror> {
  let bytes: Uint8Array | null = null
  try {
    bytes = await store.load()
  } catch {
    bytes = null
  }
  let recovered = false
  let opened: { raw: Database; db: PhoneDb }
  try {
    opened = create(sql, bytes)
  } catch {
    // Not a database we can use: it is only a cache, start again.
    recovered = bytes !== null
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
