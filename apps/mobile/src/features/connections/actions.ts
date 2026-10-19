/**
 * Device edge: what the slice 3 buttons do. Each write lives in `@bullet/client` (change + outbox op in
 * one transaction); here we run it, refresh live queries, sync and announce. Nothing notifies.
 * "Close it" / "Keep open" go through the Inbox's held Undo window (`decideLoopAnswer`).
 */

import { AccessibilityInfo } from 'react-native'
import {
  answerConnection,
  cardIsNew,
  cleanThemeName,
  COPY,
  dismissNoticed,
  mergeTheme,
  openNoticed,
  rejectSuggestion,
  renameTheme,
  retireTheme,
  vetoLink,
} from '@bullet/client'
import { getDb } from '../../data/open'
import { deviceDeps } from '../../sync/runtime'
import { decideLoopAnswer } from '../inbox/actions'
import { notifyLocalChange, syncNow } from '../sync/engine'

function run(write: () => void, message: string | null): void {
  write()
  notifyLocalChange()
  void syncNow()
  if (message) AccessibilityInfo.announceForAccessibility(message)
}

/** "Close it": the loop is closed by the answering capture (Undo here, then under Done for you). */
export const closeLoop = (suggestionId: string) => decideLoopAnswer(suggestionId, 'accepted')

/** "Keep open": the pair is remembered for good once the Undo window closes. */
export const keepLoopOpen = (suggestionId: string) => decideLoopAnswer(suggestionId, 'dismissed')

/**
 * "Already closed" → OK: let the card go. Rejecting records a permanent resolve veto for this
 * pair on the server; harmless here, since the loop is closed already.
 */
export const clearClosed = (suggestionId: string) =>
  run(() => rejectSuggestion(getDb(), suggestionId, deviceDeps), null)

/** "Same thing" / "Different" on a connection question. */
export const answerSame = (questionId: string, same: boolean) =>
  run(
    () => answerConnection(getDb(), questionId, same, deviceDeps),
    same ? COPY.sameThing : COPY.different,
  )

/** "Not related" on a Related row. */
export const notRelated = (linkId: string) =>
  run(() => vetoLink(getDb(), linkId, deviceDeps), COPY.removed)

/** "Open" on a Noticed card: marked opened once (nothing is sent for a card opened before). */
export function openCard(cardId: string): void {
  if (!cardIsNew(getDb(), cardId)) return
  run(() => openNoticed(getDb(), cardId, deviceDeps), null)
}

/** "Clear" on a Noticed card: the card goes; its theme stays. */
export const dismissCard = (cardId: string) =>
  run(() => dismissNoticed(getDb(), cardId, deviceDeps), COPY.removed)

/** "Not a theme": the theme is retired, and its cards stop showing with it. */
export const notATheme = (themeId: string) =>
  run(() => retireTheme(getDb(), themeId, deviceDeps), COPY.removed)

/** Rename from the pill or the sheet. Returns false (nothing written) for an empty name. */
export function renameThemeTo(themeId: string, typed: string): boolean {
  const name = cleanThemeName(typed)
  if (!name) return false
  run(() => renameTheme(getDb(), themeId, name, deviceDeps), COPY.renamed)
  return true
}

/** "Merge with…": this theme folds into the one picked. */
export const mergeInto = (themeId: string, intoThemeId: string) =>
  run(() => mergeTheme(getDb(), themeId, intoThemeId, deviceDeps), COPY.merged)
