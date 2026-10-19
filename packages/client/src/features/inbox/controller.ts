/**
 * What the Inbox's buttons do, runtime-free: the phone and the web app each build one controller
 * with their own edges (database handle, clock, ids, "refresh the screens", "sync soon", a
 * screen-reader announcement) and call the same functions. Writes go through this package
 * (change + outbox op in one transaction); this file runs the Undo window and decides when to
 * sync.
 *
 *  - Accept / Dismiss are written at once with their op on hold (`decideHeld`): the sync client
 *    won't send it while the window is open, whatever else syncs meanwhile. Undo in the window
 *    takes it back (`retractDecision`). The hold is released when the window closes, when the
 *    Inbox is left (`flushDecisions`) and when the app goes to the background; it also runs out
 *    by itself.
 *  - Answers, Skip and Undo of something already applied are sent at once.
 */

import type { SuggestionPayload } from '@bullet/core'
import { eq } from 'drizzle-orm'
import type { PhoneDb } from '../../data/db'
import { clearRejection, findRejection } from '../../data/rejections'
import {
  answerQuestion as answerQuestionLocal,
  dismissQuestion,
  type LocalDeps,
  undoSuggestion,
} from '../../data/local'
import { decideHeld, releaseHolds, restoreSuggestion, retractDecision } from '../../data/decisions'
import { suggestions } from '../../data/schema'
import { COPY } from '../connections/copy'
import { createStore, type Store } from '../store'
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

export type UndoOutcome = 'restored' | 'undone' | 'already_sent'

export const UNDO_MESSAGES: Record<UndoOutcome, string> = {
  restored: 'Back in To decide.',
  undone: 'Undone.',
  already_sent: 'That had already reached your home server, so it stays dismissed.',
}

export interface InboxControllerEnv {
  db: () => PhoneDb
  deps: LocalDeps
  /** Re-run live queries (call after a local write). */
  notify: () => void
  /** Sync soon (after something that should reach the server). */
  syncNow: () => void
  /** A calm screen-reader announcement. */
  announce: (message: string) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface InboxController {
  /** Open Undo windows, shared by every screen that shows them. */
  undoStore: Store<UndoState>
  accept: (id: string, label: string, payload?: SuggestionPayload) => void
  /** "Start tracking": accept a new tracker, with the name the user left in its field. */
  startTracking: (id: string, name: string) => void
  /** "Accept both / all": several ops, sent together in one push when the window closes. */
  acceptAll: (ids: readonly string[]) => void
  /** "Did this close it?": Close it (accepted) or Keep open (dismissed), in the same window. */
  decideLoopAnswer: (id: string, decision: Decision) => void
  dismiss: (id: string, label: string) => void
  /** Undo inside the window, or the server's way if it was already sent. */
  undoDecision: (id: string) => UndoOutcome
  /** Undo something applied (Done for you). The server may refuse if it was edited since. */
  undoApplied: (id: string, label: string) => void
  /** Tap a quick option: applied straight away (locally now, on the server at the next sync). */
  answerWithOption: (questionId: string, option: string) => void
  /** Skip a question for good. */
  skipQuestion: (questionId: string) => void
  dismissNotice: (key: string) => void
  /** Leaving the Inbox (or going to the background): close every window and send. */
  flushDecisions: () => void
}

export function createInboxController(env: InboxControllerEnv): InboxController {
  const now = env.now ?? Date.now
  const setTimer = env.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = env.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const undoStore = createStore<UndoState>([])
  let timer: unknown = null

  const stopTimer = () => {
    if (timer !== null) clearTimer(timer)
    timer = null
  }

  /** Close windows that ran out, release and send their ops, and wait for the next one. */
  function tick() {
    stopTimer()
    const before = undoStore.get()
    const after = expireDecisions(before, now())
    if (after !== before) {
      const open = new Set(after.map((e) => e.suggestionId))
      releaseHolds(
        env.db(),
        before.filter((e) => !open.has(e.suggestionId)).map((e) => e.suggestionId),
      )
      undoStore.set(after)
      env.syncNow()
    }
    const next = nextExpiry(after)
    if (next !== null) timer = setTimer(tick, Math.max(0, next - now()))
  }

  function closeAll() {
    stopTimer()
    releaseHolds(env.db())
    if (undoStore.get().length === 0) return
    undoStore.set([])
    env.notify()
    env.syncNow()
  }

  function currentPayload(id: string): { payload: SuggestionPayload; bulletId: string } | null {
    const s = env
      .db()
      .select({ payload: suggestions.payload, bullet: suggestions.source_bullet_id })
      .from(suggestions)
      .where(eq(suggestions.id, id))
      .get()
    return s ? { payload: s.payload, bulletId: s.bullet } : null
  }

  /** Decide and hold. Suggestions no longer pending (a double tap) are skipped. */
  function decide(ids: readonly string[], decision: Decision, payload?: SuggestionPayload): number {
    const db = env.db()
    const at = now()
    let state = undoStore.get()
    let decided = 0
    for (const id of ids) {
      const before = currentPayload(id)
      if (!before) continue
      if (!decideHeld(db, id, decision, at + UNDO_WINDOW_MS, env.deps, payload)) continue
      decided += 1
      state = addDecision(state, {
        suggestionId: id,
        decision,
        bulletId: before.bulletId,
        decidedAt: at,
        previousPayload: before.payload,
      })
    }
    undoStore.set(state)
    env.notify()
    tick()
    return decided
  }

  return {
    undoStore,

    accept(id, label, payload) {
      if (decide([id], 'accepted', payload) > 0) {
        env.announce(`Added ${label}. Undo is available for a few seconds.`)
      }
    },

    startTracking(id, name) {
      const current = currentPayload(id)
      if (!current) return
      const payload = current.payload.name === name ? undefined : { ...current.payload, name }
      if (decide([id], 'accepted', payload) > 0) {
        env.announce(`Started tracking ${name}. Undo is available for a few seconds.`)
      }
    },

    acceptAll(ids) {
      const n = decide(ids, 'accepted')
      if (n > 0) env.announce(`Added ${n}. Undo is available for a few seconds.`)
    },

    decideLoopAnswer(id, decision) {
      if (decide([id], decision) > 0) {
        env.announce(decision === 'accepted' ? COPY.closed : COPY.keptOpen)
      }
    },

    dismiss(id, label) {
      if (decide([id], 'dismissed') > 0) {
        env.announce(`Dismissed ${label}. Undo is available for a few seconds.`)
      }
    },

    undoDecision(id) {
      const entry = findDecision(undoStore.get(), id)
      const db = env.db()
      const at = now()
      const previous = entry?.previousPayload ?? currentPayload(id)?.payload ?? {}
      const refused = findRejection(db, id, ['suggestion.accept'])
      let outcome: UndoOutcome
      if (entry && retractDecision(db, id, previous, at)) {
        outcome = 'restored'
      } else if (refused) {
        // The server already refused the accept: nothing was applied, so just put it back here.
        restoreSuggestion(db, id, previous, at)
        clearRejection(db, refused.key)
        outcome = 'restored'
      } else if (entry?.decision === 'accepted') {
        // Sent (or being sent): remove what it added, after it.
        undoSuggestion(db, id, env.deps)
        env.syncNow()
        outcome = 'undone'
      } else {
        outcome = 'already_sent'
      }
      undoStore.set(removeDecision(undoStore.get(), id))
      env.notify()
      tick()
      env.announce(UNDO_MESSAGES[outcome])
      return outcome
    },

    undoApplied(id, label) {
      undoSuggestion(env.db(), id, env.deps)
      env.notify()
      env.syncNow()
      env.announce(`Undone: ${label}.`)
    },

    answerWithOption(questionId, option) {
      answerQuestionLocal(env.db(), questionId, option, env.deps)
      env.notify()
      env.syncNow()
      env.announce(`Answered ${option}.`)
    },

    skipQuestion(questionId) {
      dismissQuestion(env.db(), questionId, env.deps)
      env.notify()
      env.syncNow()
      env.announce('Skipped.')
    },

    dismissNotice(key) {
      clearRejection(env.db(), key)
      env.notify()
    },

    flushDecisions: closeAll,
  }
}
