/**
 * Reconcile a bullet's fresh extraction with what it produced before (CLAUDE.md §4.6). Runs inside
 * ONE transaction, after the model has answered ("extract first, then retire"):
 *
 *  - keep matches   — an existing suggestion that matches a new draft stays. A still-pending one
 *                     takes the new payload/confidence/tier; an accepted/edited one is left as the
 *                     user has it; a rejected one stays rejected (never resurrected).
 *  - add new        — drafts with no match become new suggestions; `auto` ones are applied.
 *  - retire removed — existing suggestions with no match are withdrawn (soft-deleted); applied ones
 *                     are undone first, unless the user has since changed the result by hand.
 *
 * Matching: first by identity (kind + operation + target + normalised title/name), then any left
 * over pair up by kind + operation + target in order — so a small rewording of the bullet keeps
 * the task the user already accepted (and edited) instead of replacing it.
 *
 * A reading that depends on a proposed tracker (`dependsOn`) gets that tracker suggestion's id as
 * its `payload.tracker_id`: ids are settled for every draft before anything is written.
 */

import { randomUUID } from 'node:crypto'
import { type ResolvedSuggestion, withProvenance } from '@bullet/engine'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { suggestions } from '../db/schema'
import { touch } from '../sync/changes'
import { ApplyError, applySuggestion, type SuggestionRow, undoSuggestion } from './apply'

const norm = (v: unknown): string =>
  typeof v === 'string' ? v.toLowerCase().trim().replace(/\s+/g, ' ') : ''

type Keyable = Pick<ResolvedSuggestion, 'target_kind' | 'operation' | 'target_id' | 'payload'>

const slotKey = (s: Keyable) => `${s.target_kind}|${s.operation}|${s.target_id ?? ''}`
const identityKey = (s: Keyable) =>
  `${slotKey(s)}|${s.operation === 'create' ? norm(s.payload.title ?? s.payload.name) : ''}`

/** Apply a suggestion the resolver marked `auto`; if it no longer applies, leave it for review. */
function autoApply(db: Db, s: SuggestionRow, now: number): void {
  if (s.tier !== 'auto' || s.status !== 'pending') return
  try {
    applySuggestion(db, s, now, { auto: true })
  } catch (err) {
    if (!(err instanceof ApplyError)) throw err
    db.update(suggestions)
      .set({ tier: 'ask', updated_at: now })
      .where(eq(suggestions.id, s.id))
      .run()
    touch(db, s.owner_id, 'suggestions', s.id)
  }
}

/** Withdraw a suggestion: undo it if applied (when the user hasn't changed the result), hide it. */
export function retireSuggestion(db: Db, s: SuggestionRow, now: number): void {
  let current = s
  if (s.applied_entity_id !== null) {
    try {
      current = undoSuggestion(db, s, now)
    } catch (err) {
      // The user changed what it produced: keep their data, just withdraw the suggestion.
      if (!(err instanceof ApplyError)) throw err
    }
  }
  db.update(suggestions)
    .set({ state: 'deleted', updated_at: now })
    .where(eq(suggestions.id, current.id))
    .run()
  touch(db, s.owner_id, 'suggestions', s.id)
}

export interface ReconcileResult {
  kept: number
  added: number
  retired: number
  /** The suggestion id now standing for each draft, in draft order. */
  ids: string[]
}

/** A thing draft plus the thought it came from (null for drafts without one). */
export type ThingDraftWithThought = ResolvedSuggestion & { thoughtId?: string | null }

export function reconcileSuggestions(
  db: Db,
  bullet: { id: string; owner_id: string },
  drafts: ThingDraftWithThought[],
  now: number,
): ReconcileResult {
  const existing = db
    .select()
    .from(suggestions)
    .where(and(eq(suggestions.source_bullet_id, bullet.id), eq(suggestions.state, 'active')))
    .all()

  const ids: string[] = Array.from({ length: drafts.length }, () => '')
  const pairs: [SuggestionRow, ThingDraftWithThought, number][] = []
  const unmatched: number[] = []
  const pool = [...existing]
  const take = (pred: (s: SuggestionRow) => boolean): SuggestionRow | undefined => {
    const i = pool.findIndex(pred)
    return i < 0 ? undefined : pool.splice(i, 1)[0]
  }
  for (const [n, d] of drafts.entries()) {
    const hit = take((s) => identityKey(s) === identityKey(d))
    if (hit) pairs.push([hit, d, n])
    else unmatched.push(n)
  }
  const added: number[] = []
  for (const n of unmatched) {
    const d = drafts[n] as ThingDraftWithThought
    const hit = take((s) => slotKey(s) === slotKey(d))
    if (hit) pairs.push([hit, d, n])
    else added.push(n)
  }
  for (const [s, , n] of pairs) ids[n] = s.id
  for (const n of added) ids[n] = randomUUID()
  // A reading of a proposed tracker logs under that suggestion's id (the tracker's id once created).
  const linked = (d: ThingDraftWithThought): ThingDraftWithThought =>
    d.dependsOn === undefined || !ids[d.dependsOn]
      ? d
      : { ...d, payload: { ...d.payload, tracker_id: ids[d.dependsOn] } }

  // Retire first, so an undo can't trip over a suggestion about to be re-added.
  for (const s of pool) retireSuggestion(db, s, now)

  for (const [s, raw] of pairs) {
    const d = linked(raw)
    if (s.status !== 'pending') continue
    const thoughtId = d.thoughtId ?? null
    const payload = withProvenance(d, bullet.owner_id, bullet.id, thoughtId).payload
    const patch = {
      payload,
      source_thought_id: thoughtId,
      confidence: d.confidence,
      tier: d.tier,
      updated_at: now,
    }
    db.update(suggestions).set(patch).where(eq(suggestions.id, s.id)).run()
    touch(db, bullet.owner_id, 'suggestions', s.id)
    autoApply(db, { ...s, ...patch }, now)
  }

  for (const n of added) {
    const d = linked(drafts[n] as ThingDraftWithThought)
    const insert = withProvenance(d, bullet.owner_id, bullet.id, d.thoughtId ?? null)
    const row: SuggestionRow = {
      ...insert,
      id: ids[n] as string,
      created_at: now,
      updated_at: now,
      state: 'active',
      applied_before: null,
      applied_after: null,
    }
    db.insert(suggestions).values(row).run()
    touch(db, bullet.owner_id, 'suggestions', row.id)
    autoApply(db, row, now)
  }

  return { kept: pairs.length, added: added.length, retired: pool.length, ids }
}

/** Is any of the bullet's suggestions still waiting for the user? */
export function hasPendingSuggestions(db: Db, bulletId: string): boolean {
  return (
    db
      .select({ id: suggestions.id })
      .from(suggestions)
      .where(
        and(
          eq(suggestions.source_bullet_id, bulletId),
          eq(suggestions.state, 'active'),
          eq(suggestions.status, 'pending'),
        ),
      )
      .get() !== undefined
  )
}
