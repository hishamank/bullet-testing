/**
 * Device edge: what the Inbox's buttons do. Writes go through `src/data` (change + outbox op in
 * one transaction); this file runs the Undo window and decides when to sync.
 *
 *  - Accept / Dismiss are written at once with their op on hold (`decideHeld`): the sync client
 *    won't send it while the window is open, whatever else syncs meanwhile. Undo in the window
 *    takes it back (`retractDecision`). The hold is released when the window closes, when the
 *    Inbox is left and when the app goes to the background; it also runs out by itself.
 *  - Answers, Skip and Undo of something already applied are sent at once.
 */

import type { SuggestionPayload } from '@bullet/core'
import { eq } from 'drizzle-orm'
import { AccessibilityInfo, AppState } from 'react-native'
import { decideHeld, releaseHolds, restoreSuggestion, retractDecision } from '../../data/decisions'
import {
  answerQuestion as answerQuestionLocal,
  dismissQuestion,
  undoSuggestion,
} from '../../data/local'
import { getDb } from '../../data/open'
import { clearRejection, findRejection } from '../../data/rejections'
import { suggestions } from '../../data/schema'
import { deviceDeps } from '../../sync/runtime'
import { COPY } from '../connections/copy'
import { createStore } from '../store'
import { notifyLocalChange, syncNow } from '../sync/engine'
import {
  addDecision,
  type Decision,
  expireDecisions,
  findDecision,
  nextExpiry,
  removeDecision,
  UNDO_WINDOW_MS,
  type UndoState,
} from './undo'

/** Open Undo windows, shared by every screen that shows them. */
export const undoStore = createStore<UndoState>([])

let timer: ReturnType<typeof setTimeout> | null = null
let watchingAppState = false

/** Close windows that ran out, release and send their ops, and wait for the next one. */
function tick() {
  if (timer !== null) clearTimeout(timer)
  timer = null
  const before = undoStore.get()
  const after = expireDecisions(before, Date.now())
  if (after !== before) {
    const open = new Set(after.map((e) => e.suggestionId))
    releaseHolds(
      getDb(),
      before.filter((e) => !open.has(e.suggestionId)).map((e) => e.suggestionId),
    )
    undoStore.set(after)
    void syncNow()
  }
  const next = nextExpiry(after)
  if (next !== null) timer = setTimeout(tick, Math.max(0, next - Date.now()))
}

/** Close every window now: release all holds and send. */
function closeAll() {
  if (timer !== null) clearTimeout(timer)
  timer = null
  releaseHolds(getDb())
  if (undoStore.get().length === 0) return
  undoStore.set([])
  notifyLocalChange()
  void syncNow()
}

/** Going to the background ends the windows: nobody can tap Undo there. */
function watchAppState() {
  if (watchingAppState) return
  watchingAppState = true
  AppState.addEventListener('change', (state) => {
    if (state === 'background') closeAll()
  })
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

/** Decide and hold. Suggestions no longer pending (a double tap) are skipped. */
function decide(ids: readonly string[], decision: Decision, payload?: SuggestionPayload): number {
  watchAppState()
  const db = getDb()
  const now = Date.now()
  let state = undoStore.get()
  let decided = 0
  for (const id of ids) {
    const before = currentPayload(id)
    if (!before) continue
    if (!decideHeld(db, id, decision, now + UNDO_WINDOW_MS, deviceDeps, payload)) continue
    decided += 1
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
  return decided
}

export function accept(id: string, label: string, payload?: SuggestionPayload): void {
  if (decide([id], 'accepted', payload) > 0) {
    announce(`Added ${label}. Undo is available for a few seconds.`)
  }
}

/** "Start tracking": accept a new tracker, with the name the user left in its field. */
export function startTracking(id: string, name: string): void {
  const current = currentPayload(id)
  if (!current) return
  const payload = current.payload.name === name ? undefined : { ...current.payload, name }
  if (decide([id], 'accepted', payload) > 0) {
    announce(`Started tracking ${name}. Undo is available for a few seconds.`)
  }
}

/** "Accept both / all": several ops, sent together in one push when the window closes. */
export function acceptAll(ids: readonly string[]): void {
  const n = decide(ids, 'accepted')
  if (n > 0) announce(`Added ${n}. Undo is available for a few seconds.`)
}

/**
 * "Did this close it?": Close it (accepted) or Keep open (dismissed, which the server keeps as a
 * permanent veto of the pair), held in the same Undo window as every other To decide card.
 */
export function decideLoopAnswer(id: string, decision: Decision): void {
  if (decide([id], decision) > 0) {
    announce(decision === 'accepted' ? COPY.closed : COPY.keptOpen)
  }
}

export function dismiss(id: string, label: string): void {
  if (decide([id], 'dismissed') > 0) {
    announce(`Dismissed ${label}. Undo is available for a few seconds.`)
  }
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
  const now = Date.now()
  const previous = entry?.previousPayload ?? currentPayload(id)?.payload ?? {}
  const refused = findRejection(db, id, ['suggestion.accept'])
  let outcome: UndoOutcome
  if (entry && retractDecision(db, id, previous, now)) {
    outcome = 'restored'
  } else if (refused) {
    // The server already refused the accept: nothing was applied, so just put it back here.
    restoreSuggestion(db, id, previous, now)
    clearRejection(db, refused.key)
    outcome = 'restored'
  } else if (entry?.decision === 'accepted') {
    // Sent (or being sent): remove what it added, after it.
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
  closeAll()
}
