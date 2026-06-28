/**
 * @bullet/db — Drizzle schema + migrations + repositories + the apply/commit engine.
 *
 * The typed REPOSITORIES and the apply/commit engine are the ONLY sanctioned way to touch the
 * database. Depends only on @bullet/core (never on @bullet/agent). All business logic lives
 * here as plain functions; a future tRPC layer is a thin wrapper.
 */

export const PACKAGE_NAME = '@bullet/db'

// Apply / commit engine (the heart of the package).
export {
  type ApplyResult,
  acceptSuggestion,
  applySuggestion,
  type DeleteMode,
  editSuggestion,
  type ResolveResult,
  rejectSuggestion,
  type SoftDeleteResult,
  softDelete,
} from './apply'
// Client / connection.
export {
  type CreateDbOptions,
  createDb,
  createTestDb,
  type Db,
  type DbConnection,
  migrationsFolder,
  runMigrations,
  type Sqlite,
} from './client'
// Env config helper.
export { DEFAULT_DATABASE_PATH, databasePathFromEnv } from './config'
// Typed errors.
export { DbError, type DbErrorCode } from './errors'
// Job queue types (a db-only concern).
export type { JobPayload, JobStatus, JobType } from './jobs'
// Repositories (the only sanctioned DB access).
export * from './repositories'
// Drizzle schema (tables + the `schema` map).
export {
  activities,
  bullets,
  jobs,
  schema,
  suggestions,
  tasks,
  trackerEntries,
  trackers,
  users,
} from './schema'
