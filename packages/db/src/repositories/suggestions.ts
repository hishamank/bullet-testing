/**
 * Suggestions repository. The extraction envelope persists until accepted/rejected/edited; it
 * is owner-scoped and soft-deletable (the bullet-level cascade lives in the apply engine).
 *
 * The status transitions (accept/reject/edit + the apply that accompanies them) live in
 * `apply.ts`; this repo owns plain persistence plus a couple of focused query helpers.
 */

import { type Suggestion, type SuggestionStatus, suggestionInsertSchema } from '@bullet/core'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../client'
import { suggestions } from '../schema'
import { type ListOptions, newId, now, parseInsert } from './shared'

export function createSuggestion(db: Db, input: unknown): Suggestion {
  const parsed = parseInsert(suggestionInsertSchema, input)
  const ts = now()
  const row: Suggestion = {
    id: parsed.id ?? newId(),
    owner_id: parsed.owner_id,
    source_bullet_id: parsed.source_bullet_id,
    target_kind: parsed.target_kind,
    operation: parsed.operation,
    target_id: parsed.target_id,
    payload: parsed.payload,
    confidence: parsed.confidence,
    tier: parsed.tier,
    status: parsed.status,
    resolved_at: parsed.resolved_at,
    created_at: parsed.created_at ?? ts,
    updated_at: parsed.updated_at ?? ts,
    state: parsed.state ?? 'active',
  }
  db.insert(suggestions).values(row).run()
  return row
}

export function getSuggestionById(db: Db, id: string): Suggestion | undefined {
  return db.select().from(suggestions).where(eq(suggestions.id, id)).get()
}

export function listSuggestions(db: Db, ownerId: string, opts: ListOptions = {}): Suggestion[] {
  const where = opts.includeDeleted
    ? eq(suggestions.owner_id, ownerId)
    : and(eq(suggestions.owner_id, ownerId), eq(suggestions.state, 'active'))
  return db.select().from(suggestions).where(where).all()
}

/** List a user's suggestions filtered by resolution status (active only by default). */
export function listSuggestionsByStatus(
  db: Db,
  ownerId: string,
  status: SuggestionStatus,
  opts: ListOptions = {},
): Suggestion[] {
  const base = and(eq(suggestions.owner_id, ownerId), eq(suggestions.status, status))
  const where = opts.includeDeleted ? base : and(base, eq(suggestions.state, 'active'))
  return db.select().from(suggestions).where(where).all()
}

/** List the suggestions extracted from one bullet (active only by default). */
export function listSuggestionsByBullet(
  db: Db,
  bulletId: string,
  opts: ListOptions = {},
): Suggestion[] {
  const where = opts.includeDeleted
    ? eq(suggestions.source_bullet_id, bulletId)
    : and(eq(suggestions.source_bullet_id, bulletId), eq(suggestions.state, 'active'))
  return db.select().from(suggestions).where(where).all()
}

/**
 * Mutable suggestion fields. The apply engine drives `status`/`resolved_at`/`payload`; this
 * generic update never touches id/owner/provenance/created_at.
 */
export type SuggestionUpdate = Partial<
  Pick<Suggestion, 'payload' | 'status' | 'resolved_at' | 'target_id' | 'confidence' | 'tier'>
>

export function updateSuggestion(
  db: Db,
  id: string,
  patch: SuggestionUpdate,
): Suggestion | undefined {
  db.update(suggestions)
    .set({ ...patch, updated_at: now() })
    .where(eq(suggestions.id, id))
    .run()
  return getSuggestionById(db, id)
}

export function softDeleteSuggestion(db: Db, id: string): Suggestion | undefined {
  db.update(suggestions)
    .set({ state: 'deleted', updated_at: now() })
    .where(eq(suggestions.id, id))
    .run()
  return getSuggestionById(db, id)
}
