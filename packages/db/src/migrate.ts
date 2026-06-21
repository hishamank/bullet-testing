/**
 * tsx-runnable migration script for the future server. Reads `DATABASE_PATH` from the
 * environment (default `./bullet.db`) and applies all pending migrations to that file.
 *
 *   pnpm --filter @bullet/db exec tsx src/migrate.ts
 */

import { createDb } from './client'
import { databasePathFromEnv } from './config'

function main(): void {
  const path = databasePathFromEnv()
  console.log(`[migrate] applying migrations to ${path}`)
  const { sqlite } = createDb(path, { migrate: true, wal: true })
  sqlite.close()
  console.log('[migrate] done')
}

main()
