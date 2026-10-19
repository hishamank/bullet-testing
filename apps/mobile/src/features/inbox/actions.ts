/**
 * Device edge: what the Inbox's buttons do. The logic (writes through `@bullet/client`, the Undo
 * window and its holds, when to sync) is the shared `createInboxController`; this file gives it the
 * phone's edges: the database, the clock, VoiceOver and the sync engine. Going to the background
 * ends the Undo windows: nobody can tap Undo there.
 */

import { AccessibilityInfo, AppState } from 'react-native'
import { createInboxController } from '@bullet/client'
import { getDb } from '../../data/open'
import { deviceDeps } from '../../sync/runtime'
import { notifyLocalChange, syncNow } from '../sync/engine'

export { UNDO_MESSAGES, type UndoOutcome } from '@bullet/client'

const controller = createInboxController({
  db: getDb,
  deps: deviceDeps,
  notify: notifyLocalChange,
  syncNow: () => void syncNow(),
  announce: (message) => AccessibilityInfo.announceForAccessibility(message),
})

AppState.addEventListener('change', (state) => {
  if (state === 'background') controller.flushDecisions()
})

/** Open Undo windows, shared by every screen that shows them. */
export const undoStore = controller.undoStore
export const {
  accept,
  startTracking,
  acceptAll,
  decideLoopAnswer,
  dismiss,
  undoDecision,
  undoApplied,
  answerWithOption,
  skipQuestion,
  dismissNotice,
  flushDecisions,
} = controller
