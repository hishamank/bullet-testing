/**
 * Voice-note recordings on the server: declaring one (with its bullet), receiving its bytes
 * (resumable by offset, idempotent by attachment id), and reading it back.
 */

import { createHash, randomUUID } from 'node:crypto'
import type { AudioUploadState, VoiceAudio } from '@bullet/core'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { audioAttachments, jobs, transcripts } from '../db/schema'
import { ApplyError } from '../apply/apply'
import type { AudioStore } from '../storage/audio-store'
import { touch } from '../sync/changes'

export type AttachmentRow = typeof audioAttachments.$inferSelect

/** The upload did not match its declared sha256; it was reset to 0. */
export class ChecksumMismatchError extends Error {}

const stateOf = (a: AttachmentRow): AudioUploadState => ({
  attachment_id: a.id,
  size_bytes: a.size_bytes,
  received_bytes: a.received_bytes,
  upload_status: a.upload_status,
})

/** Declare a voice bullet's recording + store its device draft (inside `bullet.create`). */
export function declareAudio(
  db: Db,
  ownerId: string,
  bulletId: string,
  audio: VoiceAudio,
  capturedAt: number,
  now: number,
): void {
  const existing = db.select().from(audioAttachments).where(eq(audioAttachments.id, audio.id)).get()
  if (existing) throw new ApplyError('invalid', `audio id ${audio.id} is already used`)
  db.insert(audioAttachments)
    .values({
      id: audio.id,
      owner_id: ownerId,
      bullet_id: bulletId,
      mime_type: audio.mime_type,
      duration_ms: audio.duration_ms,
      size_bytes: audio.size_bytes,
      sha256: audio.sha256,
      storage_key: audio.id,
      received_bytes: 0,
      upload_status: 'pending',
      created_at: now,
      updated_at: now,
    })
    .run()
  touch(db, ownerId, 'audio_attachments', audio.id)
  const draftId = randomUUID()
  db.insert(transcripts)
    .values({
      id: draftId,
      owner_id: ownerId,
      bullet_id: bulletId,
      attachment_id: audio.id,
      kind: 'device_draft',
      ...audio.draft,
      transcribed_at: capturedAt,
      created_at: now,
      updated_at: now,
    })
    .run()
  touch(db, ownerId, 'transcripts', draftId)
}

/** The bullet's active recording, if any. */
export function attachmentForBullet(db: Db, bulletId: string): AttachmentRow | undefined {
  return db
    .select()
    .from(audioAttachments)
    .where(and(eq(audioAttachments.bullet_id, bulletId), eq(audioAttachments.state, 'active')))
    .get()
}

function getAttachment(db: Db, ownerId: string, id: string): AttachmentRow {
  const a = db
    .select()
    .from(audioAttachments)
    .where(and(eq(audioAttachments.id, id), eq(audioAttachments.owner_id, ownerId)))
    .get()
  if (!a) throw new ApplyError('not_found', `audio ${id} not found`)
  return a
}

export function uploadState(db: Db, ownerId: string, id: string): AudioUploadState {
  return stateOf(getAttachment(db, ownerId, id))
}

/**
 * Receive `bytes` starting at `offset`. The offset must equal what the server already has
 * (`conflict` otherwise). The final chunk verifies the sha256 and releases the bullet's job.
 */
export function receiveAudioChunk(
  db: Db,
  store: AudioStore,
  ownerId: string,
  id: string,
  offset: number,
  bytes: Uint8Array,
  now: number,
): AudioUploadState {
  const a = getAttachment(db, ownerId, id)
  if (a.upload_status === 'uploaded') return stateOf(a)
  if (offset !== a.received_bytes) {
    throw new ApplyError('conflict', `expected offset ${a.received_bytes}, got ${offset}`)
  }
  if (offset + bytes.length > a.size_bytes) {
    throw new ApplyError('invalid', `upload exceeds the declared ${a.size_bytes} bytes`)
  }
  if (bytes.length === 0) return stateOf(a)

  store.write(a.storage_key, offset, bytes)
  const received = offset + bytes.length
  const complete = received === a.size_bytes

  if (complete && a.sha256 !== null) {
    const digest = createHash('sha256').update(store.read(a.storage_key)).digest('hex')
    if (digest !== a.sha256) {
      db.update(audioAttachments)
        .set({ received_bytes: 0, updated_at: now })
        .where(eq(audioAttachments.id, a.id))
        .run()
      touch(db, ownerId, 'audio_attachments', a.id)
      throw new ChecksumMismatchError('recording checksum mismatch; upload restarted')
    }
  }

  return db.transaction((tx) => {
    tx.update(audioAttachments)
      .set({
        received_bytes: received,
        upload_status: complete ? 'uploaded' : 'pending',
        updated_at: now,
      })
      .where(eq(audioAttachments.id, a.id))
      .run()
    touch(tx, ownerId, 'audio_attachments', a.id)
    if (complete) {
      // The bullet was waiting for its recording: it can be processed now.
      tx.update(jobs)
        .set({ status: 'queued', run_after: now, updated_at: now })
        .where(and(eq(jobs.bullet_id, a.bullet_id), eq(jobs.status, 'waiting_audio')))
        .run()
    }
    return {
      ...stateOf(a),
      received_bytes: received,
      upload_status: complete ? 'uploaded' : 'pending',
    }
  })
}

export function readAudio(db: Db, store: AudioStore, ownerId: string, id: string) {
  const a = getAttachment(db, ownerId, id)
  if (a.upload_status !== 'uploaded')
    throw new ApplyError('conflict', 'recording not fully uploaded')
  return { bytes: store.read(a.storage_key), mimeType: a.mime_type }
}

/** The server transcript of a recording, if Whisper already ran on it. */
export function serverTranscriptFor(db: Db, attachmentId: string) {
  return db
    .select()
    .from(transcripts)
    .where(
      and(
        eq(transcripts.attachment_id, attachmentId),
        eq(transcripts.kind, 'server'),
        eq(transcripts.state, 'active'),
      ),
    )
    .get()
}
