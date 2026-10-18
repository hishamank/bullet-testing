/** Device edge: what the capture page's buttons do. The writes themselves live in `src/data`. */

import * as Haptics from 'expo-haptics'
import { captureBullet, retryBullet } from '../../data/local'
import { getDb } from '../../data/open'
import { deviceDeps } from '../../sync/runtime'
import { notifyLocalChange, syncNow } from '../sync/engine'

export interface SendOptions {
  /** This capture answers a clarifying question. */
  answersQuestionId?: string
}

/** Save on the phone first (always works, offline included), then try to sync. */
export function sendCapture(text: string, opts: SendOptions = {}): string {
  const id = captureBullet(getDb(), { text, answersQuestionId: opts.answersQuestionId }, deviceDeps)
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {
    // No haptics engine (simulator, web): saving is what matters.
  })
  notifyLocalChange()
  void syncNow()
  return id
}

/** Retry every failed capture (each one's retry is idempotent on the server). */
export function retryCaptures(ids: readonly string[]): void {
  if (ids.length === 0) return
  const db = getDb()
  for (const id of ids) retryBullet(db, id, deviceDeps)
  notifyLocalChange()
  void syncNow()
}
