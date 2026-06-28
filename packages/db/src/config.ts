/**
 * Tiny config helper. `createDb` itself takes an explicit `url` (so tests can pass
 * `':memory:'`); this resolves the server's database path from the environment.
 */

/** Default on-disk database file when `DATABASE_PATH` is unset. */
export const DEFAULT_DATABASE_PATH = './bullet.db'

/** Resolve the database path from `process.env.DATABASE_PATH`, falling back to the default. */
export function databasePathFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.DATABASE_PATH?.trim() || DEFAULT_DATABASE_PATH
}
