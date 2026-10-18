/**
 * Device edge: what the recording screen's buttons do once audio exists. The writes themselves
 * live in save.ts / `src/data`.
 */

import * as Haptics from 'expo-haptics'
import type { CaptureLinks } from '../../data/local'
import { notifyLocalChange, syncNow } from '../sync/engine'
import { voiceStoreDeps } from './device'
import { createRecovery, discardSession, saveVoiceNote } from './save'
import type { FinishedRecording } from './session'

export { returnToCapture } from './return'

function afterLocalWrite() {
  notifyLocalChange()
  void syncNow()
}

/** Sessions recording or being saved right now: recovery leaves them alone. */
const liveSessions = new Set<string>()

export function markSessionLive(sessionId: string, live: boolean): void {
  if (live) liveSessions.add(sessionId)
  else liveSessions.delete(sessionId)
}

/** Save on the phone (always works, offline included), then try to sync. */
export async function saveRecording(
  sessionId: string,
  rec: FinishedRecording,
  links: CaptureLinks,
): Promise<string | null> {
  const id = await saveVoiceNote(voiceStoreDeps(), sessionId, rec, links).finally(() =>
    markSessionLive(sessionId, false),
  )
  if (id) {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {
      // No haptics engine (simulator): saving is what matters.
    })
    afterLocalWrite()
  }
  return id
}

export function discardRecording(sessionId: string, files: string[]): void {
  markSessionLive(sessionId, false)
  discardSession(voiceStoreDeps(), sessionId, files)
}

const recover = createRecovery(voiceStoreDeps, liveSessions)

/**
 * Save recordings a crash or a kill interrupted. Safe to call any time: skips live sessions, and
 * a call during a run joins it (app start and a recording started right after can overlap).
 */
export async function recoverInterruptedRecordings(): Promise<void> {
  try {
    const saved = await recover()
    if (saved.length > 0) afterLocalWrite()
  } catch {
    // A broken leftover stays on disk for the next attempt; never block recording on it.
  }
}
