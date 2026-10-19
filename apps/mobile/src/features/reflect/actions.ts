/**
 * Device edge: what the reflective question buttons do. Writes live in `src/data` (change + op in
 * one transaction); this file only notifies the screens, syncs and announces.
 */

import { AccessibilityInfo } from 'react-native'
import { dismissQuestion, pickEvergreen, snoozeQuestion } from '../../data/local'
import { getDb } from '../../data/open'
import { deviceDeps } from '../../sync/runtime'
import { notifyLocalChange, syncNow } from '../sync/engine'

function done(message: string) {
  notifyLocalChange()
  void syncNow()
  AccessibilityInfo.announceForAccessibility(message)
}

/** "Later": hidden for a week (a second Later lets it go quietly). */
export function laterQuestion(questionId: string): void {
  snoozeQuestion(getDb(), questionId, deviceDeps)
  done('Saved for later.')
}

/** "Not this one": dismissed for good, and its thought is never asked about again. */
export function notThisOne(questionId: string): void {
  dismissQuestion(getDb(), questionId, deviceDeps)
  done('Removed.')
}

/**
 * "Pick a question": created on the phone at once (answerable offline). Returns its id, or null
 * when enough questions are open already.
 */
export function pickQuestion(templateId: string): string | null {
  try {
    const id = pickEvergreen(getDb(), templateId, deviceDeps)
    notifyLocalChange()
    void syncNow()
    return id
  } catch {
    return null
  }
}
