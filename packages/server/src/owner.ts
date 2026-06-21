/**
 * Single-user owner resolution (v1). Every persisted entity carries `owner_id` (cheap insurance
 * for a multi-user future), but v1 has exactly one user. `getOrCreateDefaultOwner` ensures one
 * user row exists and returns its id, used as `owner_id` for every procedure.
 *
 * Thin wrapper over the @bullet/db users repository — no business logic here.
 */

import { createUser, type Db, listUsers } from '@bullet/db'

/** The display name minted for the single v1 owner when none exists yet. */
export const DEFAULT_OWNER_NAME = 'You'

/**
 * Return the id of the single owner, creating the row if the database has no users yet. With one
 * writer and a serial worker this read-then-create is race-free for the local server.
 */
export function getOrCreateDefaultOwner(db: Db): string {
  const existing = listUsers(db)
  const first = existing[0]
  if (first) return first.id
  return createUser(db, { name: DEFAULT_OWNER_NAME }).id
}
