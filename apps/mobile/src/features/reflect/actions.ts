/**
 * Device edge: what the reflective question buttons do. Writes live in `@bullet/client` (change + op in
 * one transaction); this file only notifies the screens, syncs and announces.
 */

import { AccessibilityInfo } from 'react-native'
import {
  dismissQuestion,
  evergreenChoices,
  laterAnnouncement,
  pickEvergreen,
  snoozeQuestion,
} from '@bullet/client'
import { getDb } from '../../data/open'
import { deviceDeps } from '../../sync/runtime'
import { notifyLocalChange, syncNow } from '../sync/engine'

function done(message: string | null) {
  notifyLocalChange()
  void syncNow()
  if (message) AccessibilityInfo.announceForAccessibility(message)
}

/** "Later": hidden for a week; a second Later lets it go quietly. */
export function laterQuestion(questionId: string): void {
  done(laterAnnouncement(snoozeQuestion(getDb(), questionId, deviceDeps)))
}

/** "Not this one": dismissed for good, and its thought is never asked about again. */
export function notThisOne(questionId: string): void {
  dismissQuestion(getDb(), questionId, deviceDeps)
  done('Removed.')
}

/**
 * "Pick a question": created on the phone at once (answerable offline). Returns its id, or null
 * when enough questions are open already (the sheet disables its rows then). Anything else that
 * goes wrong is a bug and is thrown.
 */
export function pickQuestion(templateId: string): string | null {
  const db = getDb()
  if (!evergreenChoices(db).canPick) return null
  const id = pickEvergreen(db, templateId, deviceDeps)
  done(null)
  return id
}
