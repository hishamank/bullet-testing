/**
 * Ops the server refused for good (`stale`, `conflict`, …), kept so the UI can explain them
 * calmly ("Couldn't add it: things changed since"). Stored in `sync_state` under a key prefix, so
 * no schema change is needed. A refusal also forces the next pull to be a full one: the server
 * didn't change the row, so an incremental pull would never bring its version back, and the
 * phone's optimistic change would linger.
 *
 * Scope: only suggestion/question ops (refused bullet ops are already noted on the bullet as
 * `sync_rejection`). Of those, only the ones the UI explains are kept as records (`EXPLAINED`),
 * so nothing piles up in `sync_state`; the rest just trigger the full pull.
 */

import type { PushOp, PushRejectCode } from '@bullet/core'
import { eq, like } from 'drizzle-orm'
import type { PhoneDb } from './db'
import { CURSOR_KEY, setState } from './mirror'
import { syncState } from './schema'

const PREFIX = 'rejection:'

export interface SyncRejection {
  /** The `sync_state` key, for `clearRejection`. */
  key: string
  type: PushOp['type']
  suggestion_id: string | null
  question_id: string | null
  code: PushRejectCode | 'malformed'
  message: string
  at: number
}

/** Refusals the UI explains, kept until the user dismisses the notice. */
export const EXPLAINED: readonly PushOp['type'][] = [
  'suggestion.accept',
  'suggestion.undo',
  'question.answer',
]

const tracked = (type: PushOp['type']) =>
  type.startsWith('suggestion.') || type.startsWith('question.')

/** Note a refused op (call inside the transaction that drops it from the outbox). */
export function recordRejection(
  tx: PhoneDb,
  row: {
    op_id: string
    type: PushOp['type']
    suggestion_id: string | null
    question_id: string | null
  },
  code: SyncRejection['code'],
  message: string,
  at: number,
): void {
  if (!tracked(row.type)) return
  // Start the next pull from scratch, so the server's own version of the row comes back.
  tx.delete(syncState).where(eq(syncState.key, CURSOR_KEY)).run()
  if (!EXPLAINED.includes(row.type)) return
  const value: Omit<SyncRejection, 'key'> = {
    type: row.type,
    suggestion_id: row.suggestion_id,
    question_id: row.question_id,
    code,
    message,
    at,
  }
  setState(tx, PREFIX + row.op_id, JSON.stringify(value))
}

/** A refusal of this decision on this suggestion, if one is waiting to be explained. */
export function findRejection(
  db: PhoneDb,
  suggestionId: string,
  types: readonly PushOp['type'][],
): SyncRejection | undefined {
  return listRejections(db).find((r) => r.suggestion_id === suggestionId && types.includes(r.type))
}

/** Refusals not yet acknowledged by the user, oldest first. */
export function listRejections(db: PhoneDb): SyncRejection[] {
  return db
    .select()
    .from(syncState)
    .where(like(syncState.key, `${PREFIX}%`))
    .all()
    .flatMap((r) => {
      try {
        return [{ ...(JSON.parse(r.value) as Omit<SyncRejection, 'key'>), key: r.key }]
      } catch {
        return []
      }
    })
    .sort((a, b) => a.at - b.at)
}

export function clearRejection(db: PhoneDb, key: string): void {
  if (!key.startsWith(PREFIX)) return
  db.delete(syncState).where(eq(syncState.key, key)).run()
}
