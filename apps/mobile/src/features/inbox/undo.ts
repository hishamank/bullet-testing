/**
 * The quiet "Added · Undo" / "Dismissed · Undo" window after a decision in To decide. Pure state:
 * the screen keeps it in a store and expires entries on a timer.
 *
 * A decision is written to the phone at once (so the Inbox count drops and nothing is lost if the
 * app dies) but is only *sent* when its window closes. Undo inside the window takes the op back
 * out of the outbox, so the server never sees it — which matters for Dismiss, since the server has
 * no "un-dismiss".
 */

import type { SuggestionPayload } from '@bullet/core'

/** How long the Undo stays on screen. Long enough to read and reach, short enough to stay calm. */
export const UNDO_WINDOW_MS = 6_000

export type Decision = 'accepted' | 'dismissed'

export interface UndoEntry {
  suggestionId: string
  decision: Decision
  /** The capture it belongs to, so the row keeps its place in its group. */
  bulletId: string
  decidedAt: number
  expiresAt: number
  /** The payload before an edit-and-accept, to put back on Undo. */
  previousPayload: SuggestionPayload
}

export type UndoState = readonly UndoEntry[]

export function addDecision(
  state: UndoState,
  entry: Omit<UndoEntry, 'expiresAt'>,
  windowMs = UNDO_WINDOW_MS,
): UndoState {
  const rest = state.filter((e) => e.suggestionId !== entry.suggestionId)
  return [...rest, { ...entry, expiresAt: entry.decidedAt + windowMs }]
}

export function removeDecision(state: UndoState, suggestionId: string): UndoState {
  return state.some((e) => e.suggestionId === suggestionId)
    ? state.filter((e) => e.suggestionId !== suggestionId)
    : state
}

/** Drop entries whose window has closed. Returns the same array when nothing expired. */
export function expireDecisions(state: UndoState, now: number): UndoState {
  return state.some((e) => e.expiresAt <= now) ? state.filter((e) => e.expiresAt > now) : state
}

/** When the next entry expires (to schedule one timer), or null when there is none. */
export function nextExpiry(state: UndoState): number | null {
  return state.length === 0 ? null : Math.min(...state.map((e) => e.expiresAt))
}

export function findDecision(state: UndoState, suggestionId: string): UndoEntry | undefined {
  return state.find((e) => e.suggestionId === suggestionId)
}
