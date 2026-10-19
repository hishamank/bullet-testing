/**
 * "Keep as audio": a phone-local choice for a voice capture the server couldn't transcribe
 * (damaged audio, or no speech). It is kept in `sync_state` (no contract change): the capture then
 * reads "Audio only" and no longer counts as failed on this phone.
 */

import { inArray } from 'drizzle-orm'
import type { PhoneDb } from '../../data/db'
import { setState } from '../../data/mirror'
import { syncState } from '../../data/schema'

const PREFIX = 'audio_only:'

export const audioOnlyKey = (bulletId: string) => `${PREFIX}${bulletId}`

export function keepAsAudioLocal(db: PhoneDb, bulletId: string): void {
  setState(db, audioOnlyKey(bulletId), '1')
}

/** Of these captures, the ones kept as audio only. */
export function keptAsAudio(db: PhoneDb, bulletIds: readonly string[]): Set<string> {
  if (bulletIds.length === 0) return new Set()
  return new Set(
    db
      .select()
      .from(syncState)
      .where(inArray(syncState.key, bulletIds.map(audioOnlyKey)))
      .all()
      .filter((r) => r.value === '1')
      .map((r) => r.key.slice(PREFIX.length)),
  )
}
