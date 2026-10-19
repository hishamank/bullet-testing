/**
 * What the buttons do. Every write lives in `@bullet/client` (the local change and its outbox op in
 * one transaction); each action here just calls it through `rt.run`, which refreshes the screens,
 * saves the local copy and syncs. The Inbox's decisions and Undo window are the shared
 * `InboxController`. Same list as the phone's `features/*\/actions.ts`.
 */

import type {
  BulletDeleteMode,
  EventManualPatch,
  TaskManualPatch,
  ThoughtKind,
  TrackerEntryValue,
} from '@bullet/core'
import {
  answerConnection,
  bullets,
  captureBullet,
  cardIsNew,
  cleanThemeName,
  COPY,
  deleteBullet,
  deleteEvent,
  deleteTask,
  deleteTrackerEntry,
  dismissNoticed,
  dismissQuestion,
  editBullet,
  evergreenChoices,
  keepAsAudioLocal,
  laterAnnouncement,
  mergeTheme,
  openNoticed,
  pickEvergreen,
  reclassifyThought,
  rejectSuggestion,
  renameTheme,
  resolveThought,
  retireTheme,
  retryBullet,
  snoozeQuestion,
  unresolveThought,
  updateEvent,
  updateTask,
  updateTrackerEntry,
  vetoLink,
} from '@bullet/client'
import { eq } from 'drizzle-orm'
import type { Runtime } from './runtime'

export function createActions(rt: Runtime) {
  const say = (message: string | null) => {
    if (message) rt.announcements.set(message)
  }

  /**
   * Captures written but not yet stored in this browser, by send attempt (the composer's id for
   * the thing it is sending, which stays the same until it succeeds). Sending an attempt again,
   * with the same text or with edited text, retries that capture: the store is retried, and
   * changed text goes through `editBullet`, so nothing is written twice.
   */
  const unstored = new Map<string, { id: string; text: string }>()
  const stillExists = (id: string) =>
    rt.db().select().from(bullets).where(eq(bullets.id, id)).get()?.state === 'active'
  async function durable(
    attempt: string,
    text: string,
    write: () => string,
    edit: (id: string) => void,
  ): Promise<string> {
    let pending = unstored.get(attempt)
    // The capture was deleted since the failed store: the edit would be refused, so start over.
    if (pending && !stillExists(pending.id)) {
      unstored.delete(attempt)
      pending = undefined
    }
    let id: string
    if (pending) {
      id = pending.id
      if (pending.text !== text.trim()) {
        rt.run(() => edit(id))
        pending.text = text.trim()
      }
    } else {
      id = rt.run(write)
    }
    if (!(await rt.flush())) {
      unstored.set(attempt, { id, text: text.trim() })
      throw new Error('could not store the capture in this browser')
    }
    unstored.delete(attempt)
    return id
  }

  return {
    // Capture
    /**
     * Save here first (always works, offline included): the capture is written, the local copy is
     * saved to IndexedDB, and only then does this resolve (and "Saved" show). If storing it fails
     * this rejects, and sending the same attempt again (edited text or not) does not write a second
     * capture. `attempt` identifies the composer's current send; it changes after a success.
     */
    sendCapture: (text: string, attempt: string, opts: { answersQuestionId?: string } = {}) =>
      durable(
        attempt,
        text,
        () => captureBullet(rt.db(), { text, answersQuestionId: opts.answersQuestionId }, rt.deps),
        (id) => editBullet(rt.db(), id, text, rt.deps),
      ),
    /** A send was given up (the panel closed, the draft emptied): forget its pending retry. */
    abandonSend: (attempt: string): void => {
      unstored.delete(attempt)
    },
    retryCaptures(ids: readonly string[]): void {
      if (ids.length === 0) return
      rt.run(() => {
        for (const id of ids) retryBullet(rt.db(), id, rt.deps)
      })
    },
    keepAsAudio(bulletId: string): void {
      rt.run(() => keepAsAudioLocal(rt.db(), bulletId))
    },

    // Journal and Capture detail
    resolveLoop: (thoughtId: string) => rt.run(() => resolveThought(rt.db(), thoughtId, rt.deps)),
    reopenLoop: (thoughtId: string) => rt.run(() => unresolveThought(rt.db(), thoughtId, rt.deps)),
    /** "Close with a note": the note is an ordinary capture that resolves the thought. */
    sendLoopNote: (text: string, thoughtId: string, attempt: string) =>
      durable(
        attempt,
        text,
        () => captureBullet(rt.db(), { text, resolvesThoughtId: thoughtId }, rt.deps),
        (id) => editBullet(rt.db(), id, text, rt.deps),
      ),
    changeKind: (thoughtId: string, kind: ThoughtKind) =>
      rt.run(() => reclassifyThought(rt.db(), thoughtId, kind, rt.deps)),
    editCapture: (bulletId: string, text: string) =>
      rt.run(() => editBullet(rt.db(), bulletId, text, rt.deps)),
    deleteCapture: (bulletId: string, mode: BulletDeleteMode) =>
      rt.run(() => deleteBullet(rt.db(), bulletId, mode, rt.deps)),
    setTaskDone: (taskId: string, done: boolean) =>
      rt.run(() => updateTask(rt.db(), taskId, { status: done ? 'done' : 'todo' }, rt.deps)),
    editTask: (taskId: string, patch: TaskManualPatch) =>
      rt.run(() => updateTask(rt.db(), taskId, patch, rt.deps)),
    removeTask: (taskId: string) => rt.run(() => deleteTask(rt.db(), taskId, rt.deps)),
    editEvent: (eventId: string, patch: EventManualPatch) =>
      rt.run(() => updateEvent(rt.db(), eventId, patch, rt.deps)),
    removeEvent: (eventId: string) => rt.run(() => deleteEvent(rt.db(), eventId, rt.deps)),
    fixReading: (entryId: string, value: TrackerEntryValue) =>
      rt.run(() => updateTrackerEntry(rt.db(), entryId, value, rt.deps)),
    removeReading: (entryId: string) => rt.run(() => deleteTrackerEntry(rt.db(), entryId, rt.deps)),

    // Inbox · reflective questions
    /** "Later": hidden for a week; a second Later lets it go quietly. */
    laterQuestion(questionId: string): void {
      const outcome = rt.run(() => snoozeQuestion(rt.db(), questionId, rt.deps))
      say(laterAnnouncement(outcome))
    },
    /** "Not this one": dismissed for good, and its thought is never asked about again. */
    notThisOne(questionId: string): void {
      rt.run(() => dismissQuestion(rt.db(), questionId, rt.deps))
      say('Removed.')
    },
    /** "Pick a question": created here at once. Null when enough questions are open already. */
    pickQuestion(templateId: string): string | null {
      if (!evergreenChoices(rt.db()).canPick) return null
      return rt.run(() => pickEvergreen(rt.db(), templateId, rt.deps))
    },

    // Inbox · connections, themes, Noticed
    closeLoop: (suggestionId: string) => rt.inbox.decideLoopAnswer(suggestionId, 'accepted'),
    keepLoopOpen: (suggestionId: string) => rt.inbox.decideLoopAnswer(suggestionId, 'dismissed'),
    /** "Already closed" → OK: let the card go (harmless: the loop is closed already). */
    clearClosed: (suggestionId: string) =>
      rt.run(() => rejectSuggestion(rt.db(), suggestionId, rt.deps)),
    answerSame(questionId: string, same: boolean): void {
      rt.run(() => answerConnection(rt.db(), questionId, same, rt.deps))
      say(same ? COPY.sameThing : COPY.different)
    },
    notRelated(linkId: string): void {
      rt.run(() => vetoLink(rt.db(), linkId, rt.deps))
      say(COPY.removed)
    },
    /** "Open" on a Noticed card: marked opened once (nothing is sent for a card opened before). */
    openCard(cardId: string): void {
      if (!cardIsNew(rt.db(), cardId)) return
      rt.run(() => openNoticed(rt.db(), cardId, rt.deps))
    },
    dismissCard(cardId: string): void {
      rt.run(() => dismissNoticed(rt.db(), cardId, rt.deps))
      say(COPY.removed)
    },
    notATheme(themeId: string): void {
      rt.run(() => retireTheme(rt.db(), themeId, rt.deps))
      say(COPY.removed)
    },
    /** Returns false (nothing written) for an empty name. */
    renameThemeTo(themeId: string, typed: string): boolean {
      const name = cleanThemeName(typed)
      if (!name) return false
      rt.run(() => renameTheme(rt.db(), themeId, name, rt.deps))
      say(COPY.renamed)
      return true
    },
    mergeInto(themeId: string, intoThemeId: string): void {
      rt.run(() => mergeTheme(rt.db(), themeId, intoThemeId, rt.deps))
      say(COPY.merged)
    },
  }
}

export type Actions = ReturnType<typeof createActions>
