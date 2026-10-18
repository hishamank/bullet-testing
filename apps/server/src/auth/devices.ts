/**
 * Per-device bearer tokens. A token is 32 random bytes (base64url) shown ONCE when the device is
 * added; the server stores only its SHA-256. A fast hash is right here: the token is high-entropy
 * random, not a password, so there is nothing to brute-force.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import type { Db } from '../db/client'
import { devices, users } from '../db/schema'

const TOKEN_PREFIX = 'bjd_'

export const hashToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex')

export const generateToken = (): string => TOKEN_PREFIX + randomBytes(32).toString('base64url')

/** The single owner of this home server, created on first use. */
export function ensureOwner(db: Db, now: number, name: string | null = null): string {
  const existing = db.select({ id: users.id }).from(users).limit(1).get()
  if (existing) return existing.id
  const id = randomUUID()
  db.insert(users).values({ id, name, created_at: now, updated_at: now }).run()
  return id
}

export interface AddedDevice {
  id: string
  ownerId: string
  name: string
  /** The plaintext token: show it once, it cannot be recovered. */
  token: string
}

export function addDevice(db: Db, name: string, now: number, ownerId?: string): AddedDevice {
  const owner = ownerId ?? ensureOwner(db, now)
  const token = generateToken()
  const id = randomUUID()
  db.insert(devices)
    .values({ id, owner_id: owner, name, token_hash: hashToken(token), created_at: now })
    .run()
  return { id, ownerId: owner, name, token }
}

export function listDevices(db: Db) {
  return db
    .select({
      id: devices.id,
      name: devices.name,
      created_at: devices.created_at,
      last_seen_at: devices.last_seen_at,
      revoked_at: devices.revoked_at,
    })
    .from(devices)
    .all()
}

export function revokeDevice(db: Db, id: string, now: number): boolean {
  return (
    db
      .update(devices)
      .set({ revoked_at: now })
      .where(and(eq(devices.id, id), isNull(devices.revoked_at)))
      .run().changes > 0
  )
}

export interface AuthenticatedDevice {
  deviceId: string
  ownerId: string
}

/** Resolve a presented token to its (non-revoked) device, recording when it was last seen. */
export function authenticate(db: Db, token: string, now: number): AuthenticatedDevice | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null
  const d = db
    .select()
    .from(devices)
    .where(and(eq(devices.token_hash, hashToken(token)), isNull(devices.revoked_at)))
    .get()
  if (!d) return null
  if (d.last_seen_at === null || now - d.last_seen_at > 60_000) {
    db.update(devices).set({ last_seen_at: now }).where(eq(devices.id, d.id)).run()
  }
  return { deviceId: d.id, ownerId: d.owner_id }
}
