/**
 * Test-only fixtures. Not exported from the package barrel (kept out of the public API); the
 * co-located *.test.ts files import it directly. Seeds the minimal owner+bullet graph the
 * domain rows need (FKs require a real user/bullet).
 */

import type { Db } from './client'
import { createBullet } from './repositories/bullets'
import { createUser } from './repositories/users'

export interface Seed {
  ownerId: string
  bulletId: string
}

/** Create an owner and one bullet, returning their ids. The common starting point for tests. */
export function seedOwnerAndBullet(db: Db, text = 'ran 5k this morning'): Seed {
  const user = createUser(db, { name: 'Test User' })
  const bullet = createBullet(db, { owner_id: user.id, text })
  return { ownerId: user.id, bulletId: bullet.id }
}
