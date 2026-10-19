/**
 * Held review decisions (the Inbox's Undo window). An accept / dismiss is written at once, with
 * its outbox op on hold (`outbox.hold_until`): the sync client won't send it until the hold is
 * released or runs out, so Undo inside the window can take it back before the server sees it.
 */

import type { SuggestionPayload } from '@bullet/core'
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import type { PhoneDb } from './db'
import { acceptSuggestion, type LocalDeps, rejectSuggestion } from './local'
import { outbox, suggestions, thoughts } from './schema'

const DECISION_OPS: ('suggestion.accept' | 'suggestion.reject')[] = [
  'suggestion.accept',
  'suggestion.reject',
]

function decisionOps(suggestionId: string) {
  return and(eq(outbox.suggestion_id, suggestionId), inArray(outbox.type, DECISION_OPS))
}

/**
 * Accept (optionally with an edited payload) or dismiss a pending suggestion, holding its op
 * until `holdUntil`. Returns false (and writes nothing) when it is no longer pending, e.g. on a
 * double tap. The write and the hold happen in the same synchronous run, so no sync can slip in
 * between.
 */
export function decideHeld(
  db: PhoneDb,
  suggestionId: string,
  decision: 'accepted' | 'dismissed',
  holdUntil: number,
  deps: LocalDeps,
  payload?: SuggestionPayload,
): boolean {
  const s = db
    .select({ status: suggestions.status, state: suggestions.state })
    .from(suggestions)
    .where(eq(suggestions.id, suggestionId))
    .get()
  if (!s || s.state !== 'active' || s.status !== 'pending') return false
  if (decision === 'accepted') acceptSuggestion(db, suggestionId, deps, payload)
  else rejectSuggestion(db, suggestionId, deps)
  db.update(outbox)
    .set({ hold_until: holdUntil })
    .where(and(decisionOps(suggestionId), eq(outbox.attempts, 0)))
    .run()
  return true
}

/** Let held decisions go (the window closed, the app went to the background). All when omitted. */
export function releaseHolds(db: PhoneDb, suggestionIds?: readonly string[]): void {
  if (suggestionIds && suggestionIds.length === 0) return
  db.update(outbox)
    .set({ hold_until: null })
    .where(
      suggestionIds
        ? and(isNotNull(outbox.hold_until), inArray(outbox.suggestion_id, [...suggestionIds]))
        : isNotNull(outbox.hold_until),
    )
    .run()
}

/**
 * Retract an accept / dismiss that hasn't left the phone: drop its op and put the suggestion
 * back to `pending` (with `payload`, its value before an edit-and-accept), in one transaction.
 * Returns false when the op was already sent or is being sent right now (`attempts > 0`): the
 * server has it or may apply it, so the caller must undo it the server's way.
 */
export function retractDecision(
  db: PhoneDb,
  suggestionId: string,
  payload: SuggestionPayload,
  now: number,
): boolean {
  return db.transaction((tx) => {
    const ops = tx
      .select({ seq: outbox.seq, attempts: outbox.attempts })
      .from(outbox)
      .where(decisionOps(suggestionId))
      .all()
    if (ops.length === 0 || ops.some((o) => o.attempts > 0)) return false
    tx.delete(outbox)
      .where(
        inArray(
          outbox.seq,
          ops.map((o) => o.seq),
        ),
      )
      .run()
    restoreSuggestion(tx, suggestionId, payload, now)
    return true
  })
}

/** Put a suggestion back to `pending` locally (its decision was retracted or refused). */
export function restoreSuggestion(
  db: PhoneDb,
  suggestionId: string,
  payload: SuggestionPayload,
  now: number,
): void {
  const s = db.select().from(suggestions).where(eq(suggestions.id, suggestionId)).get()
  db.update(suggestions)
    .set({
      status: 'pending',
      resolved_at: null,
      payload,
      updated_at: now,
      // A "Did this close it?" accept also recorded what it applied: take that back too.
      ...(s?.target_kind === 'thought_resolve'
        ? { applied_entity_id: null, applied_at: null }
        : {}),
    })
    .where(eq(suggestions.id, suggestionId))
    .run()
  // ...and the loop it closed on the phone is open again.
  if (s?.target_kind === 'thought_resolve' && s.target_id) {
    db.update(thoughts)
      .set({ resolved_at: null, resolved_by_bullet_id: null, updated_at: now })
      .where(
        and(eq(thoughts.id, s.target_id), eq(thoughts.resolved_by_bullet_id, s.source_bullet_id)),
      )
      .run()
  }
}
