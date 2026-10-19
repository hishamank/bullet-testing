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
import type { Runtime } from './runtime'

export function createActions(rt: Runtime) {
  const say = (message: string | null) => {
    if (message) rt.announcements.set(message)
  }

  /** A capture written but not yet stored: sending it again only retries the store. */
  let unstored: { key: string; id: string } | null = null
  async function durable(key: string, write: () => string): Promise<string> {
    const id = unstored?.key === key ? unstored.id : rt.run(write)
    if (!(await rt.flush())) {
      unstored = { key, id }
      throw new Error('could not store the capture in this browser')
    }
    unstored = null
    return id
  }

  return {
    // Capture
    /**
     * Save here first (always works, offline included): the capture is written, the local copy is
     * saved to IndexedDB, and only then does this resolve (and "Saved" show). If storing it fails
     * this rejects, and sending the same text again does not write it twice.
     */
    sendCapture: (text: string, opts: { answersQuestionId?: string } = {}) =>
      durable(`q:${opts.answersQuestionId ?? ''}|${text}`, () =>
        captureBullet(rt.db(), { text, answersQuestionId: opts.answersQuestionId }, rt.deps),
      ),
    retryCaptures(ids: readonly string[]): void {
      if (ids.length === 0) return
      rt.run(() => {
        for (const id of ids) retryBullet(rt.db(), id, rt.deps)
      })
    },
    keepAsAudio(bulletId: string): void {
      keepAsAudioLocal(rt.db(), bulletId)
      rt.notify()
    },

    // Journal and Capture detail
    resolveLoop: (thoughtId: string) => rt.run(() => resolveThought(rt.db(), thoughtId, rt.deps)),
    reopenLoop: (thoughtId: string) => rt.run(() => unresolveThought(rt.db(), thoughtId, rt.deps)),
    /** "Close with a note": the note is an ordinary capture that resolves the thought. */
    sendLoopNote: (text: string, thoughtId: string) =>
      durable(`t:${thoughtId}|${text}`, () =>
        captureBullet(rt.db(), { text, resolvesThoughtId: thoughtId }, rt.deps),
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
