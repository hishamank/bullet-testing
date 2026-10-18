/**
 * Device edge: what the Inbox's buttons do. Writes go through `src/data` (change + outbox op in
 * one transaction); this file adds the Undo window and decides when to sync.
 *
 *  - Accept / Dismiss are written at once but *sent* when their Undo window closes, so an Undo in
 *    the window simply takes the op back (`retractDecision`). Leaving the Inbox sends right away.
 *  - Answers, Skip and Undo of something already applied are sent at once.
 */

import type { SuggestionPayload } from '@bullet/core'
import { eq } from 'drizzle-orm'
import { AccessibilityInfo } from 'react-native'
import { retractDecision } from '../../data/decisions'
import {
  acceptSuggestion,
  answerQuestion as answerQuestionLocal,
  dismissQuestion,
  rejectSuggestion,
  undoSuggestion,
} from '../../data/local'
import { getDb } from '../../data/open'
import { clearRejection } from '../../data/rejections'
import { suggestions } from '../../data/schema'
import { deviceDeps } from '../../sync/runtime'
import { createStore } from '../store'
import { notifyLocalChange, syncNow } from '../sync/engine'
import {
  addDecision,
  type Decision,
  expireDecisions,
  findDecision,
  nextExpiry,
  removeDecision,
  type UndoState,
} from './undo'

/** Open Undo windows, shared by every screen that shows them. */
export const undoStore = createStore<UndoState>([])

let timer: ReturnType<typeof setTimeout> | null = null

/** Close windows that ran out, send their ops, and wait for the next one. */
function tick() {
  if (timer !== null) clearTimeout(timer)
  timer = null
  const before = undoStore.get()
  const after = expireDecisions(before, Date.now())
  if (after !== before) {
    undoStore.set(after)
    void syncNow()
  }
  const next = nextExpiry(after)
  if (next !== null) timer = setTimeout(tick, Math.max(0, next - Date.now()))
}

function changed() {
  notifyLocalChange()
}

function announce(message: string) {
  AccessibilityInfo.announceForAccessibility(message)
}

function currentPayload(id: string): { payload: SuggestionPayload; bulletId: string } | null {
  const s = getDb()
    .select({ payload: suggestions.payload, bullet: suggestions.source_bullet_id })
    .from(suggestions)
    .where(eq(suggestions.id, id))
    .get()
  return s ? { payload: s.payload, bulletId: s.bullet } : null
}

function decide(ids: readonly string[], decision: Decision, payload?: SuggestionPayload) {
  const db = getDb()
  const now = Date.now()
  let state = undoStore.get()
  for (const id of ids) {
    const before = currentPayload(id)
    if (!before) continue
    if (decision === 'accepted') acceptSuggestion(db, id, deviceDeps, payload)
    else rejectSuggestion(db, id, deviceDeps)
    state = addDecision(state, {
      suggestionId: id,
      decision,
      bulletId: before.bulletId,
      decidedAt: now,
      previousPayload: before.payload,
    })
  }
  undoStore.set(state)
  changed()
  tick()
}

export function accept(id: string, label: string, payload?: SuggestionPayload): void {
  decide([id], 'accepted', payload)
  announce(`Added ${label}. Undo is available for a few seconds.`)
}

/** "Accept both / all": several ops, sent together in one push when the window closes. */
export function acceptAll(ids: readonly string[]): void {
  decide(ids, 'accepted')
  announce(`Added ${ids.length}. Undo is available for a few seconds.`)
}

export function dismiss(id: string, label: string): void {
  decide([id], 'dismissed')
  announce(`Dismissed ${label}. Undo is available for a few seconds.`)
}

export type UndoOutcome = 'restored' | 'undone' | 'already_sent'

export const UNDO_MESSAGES: Record<UndoOutcome, string> = {
  restored: 'Back in To decide.',
  undone: 'Undone.',
  already_sent: 'That had already reached your home server, so it stays dismissed.',
}

/** Undo inside the window: take the decision back, or undo it the server's way if it was sent. */
export function undoDecision(id: string): UndoOutcome {
  const entry = findDecision(undoStore.get(), id)
  const db = getDb()
  let outcome: UndoOutcome
  if (entry && retractDecision(db, id, entry.previousPayload, Date.now())) {
    outcome = 'restored'
  } else if (entry?.decision === 'accepted') {
    // Already sent (a sync ran meanwhile): remove what it added.
    undoSuggestion(db, id, deviceDeps)
    void syncNow()
    outcome = 'undone'
  } else {
    outcome = 'already_sent'
  }
  undoStore.set(removeDecision(undoStore.get(), id))
  changed()
  tick()
  announce(UNDO_MESSAGES[outcome])
  return outcome
}

/** Undo something applied (Done for you). The server may refuse if it was edited since. */
export function undoApplied(id: string, label: string): void {
  undoSuggestion(getDb(), id, deviceDeps)
  changed()
  void syncNow()
  announce(`Undone: ${label}.`)
}

/** Tap a quick option: applied straight away (on the phone now, on the server at the next sync). */
export function answerWithOption(questionId: string, option: string): void {
  answerQuestionLocal(getDb(), questionId, option, deviceDeps)
  changed()
  void syncNow()
  announce(`Answered ${option}.`)
}

/** Skip a question for good. */
export function skipQuestion(questionId: string): void {
  dismissQuestion(getDb(), questionId, deviceDeps)
  changed()
  void syncNow()
  announce('Skipped.')
}

export function dismissNotice(key: string): void {
  clearRejection(getDb(), key)
  changed()
}

/** Leaving the Inbox: close every Undo window and send what was decided. */
export function flushDecisions(): void {
  if (undoStore.get().length === 0) return
  undoStore.set([])
  tick()
  void syncNow()
}
