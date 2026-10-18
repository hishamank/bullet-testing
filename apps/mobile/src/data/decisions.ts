/**
 * Taking back a review decision that hasn't left the phone yet (the Inbox's Undo window).
 */

import type { SuggestionPayload } from '@bullet/core'
import { and, eq, inArray } from 'drizzle-orm'
import type { PhoneDb } from './db'
import { outbox, suggestions } from './schema'

/**
 * Retract an accept / dismiss still waiting in the outbox: drop its op and put the suggestion
 * back to `pending` (with `payload`, its value before an edit-and-accept), in one transaction.
 * Returns false when the op was already sent: the server has it, so the caller must undo it the
 * server's way (`suggestion.undo` for an accept; a dismissal stays).
 */
export function retractDecision(
  db: PhoneDb,
  suggestionId: string,
  payload: SuggestionPayload,
  now: number,
): boolean {
  return db.transaction((tx) => {
    const ops = tx
      .select({ seq: outbox.seq })
      .from(outbox)
      .where(
        and(
          eq(outbox.suggestion_id, suggestionId),
          inArray(outbox.type, ['suggestion.accept', 'suggestion.reject']),
        ),
      )
      .all()
    if (ops.length === 0) return false
    tx.delete(outbox)
      .where(
        inArray(
          outbox.seq,
          ops.map((o) => o.seq),
        ),
      )
      .run()
    tx.update(suggestions)
      .set({ status: 'pending', resolved_at: null, payload, updated_at: now })
      .where(eq(suggestions.id, suggestionId))
      .run()
    return true
  })
}
