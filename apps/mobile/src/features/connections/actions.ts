/**
 * Device edge: what the slice 3 buttons do. Each write lives in `src/data` (change + outbox op in
 * one transaction); here we run it, refresh live queries, sync and announce. Nothing notifies.
 */

import { AccessibilityInfo } from 'react-native'
import {
  acceptSuggestion,
  answerConnection,
  mergeTheme,
  openNoticed,
  rejectSuggestion,
  renameTheme,
  retireTheme,
  vetoLink,
} from '../../data/local'
import { getDb } from '../../data/open'
import { deviceDeps } from '../../sync/runtime'
import { notifyLocalChange, syncNow } from '../sync/engine'
import { COPY } from './copy'
import { cleanThemeName } from './model'

function run(write: () => void, message: string | null): void {
  write()
  notifyLocalChange()
  void syncNow()
  if (message) AccessibilityInfo.announceForAccessibility(message)
}

/** "Close it": the loop is closed by the answering capture (Undo is under Done for you). */
export const closeLoop = (suggestionId: string) =>
  run(() => acceptSuggestion(getDb(), suggestionId, deviceDeps), COPY.closed)

/** "Keep open": the pair is remembered and never proposed again. */
export const keepLoopOpen = (suggestionId: string) =>
  run(() => rejectSuggestion(getDb(), suggestionId, deviceDeps), COPY.keptOpen)

/** "Already closed" → OK: let the card go (nothing else changes; the loop is closed already). */
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

/** "Open" on a Noticed card (the screen then shows the theme's captures). */
export const openCard = (cardId: string) =>
  run(() => openNoticed(getDb(), cardId, deviceDeps), null)

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
