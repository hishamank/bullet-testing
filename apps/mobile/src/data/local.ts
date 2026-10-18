/**
 * Local writes. Every user action changes the local database AND appends its outbox op in ONE
 * transaction, so a change can never exist without the op that will sync it (or vice versa).
 * The UI reflects the change at once; the server's answer arrives with the next pull.
 */

import type { BulletDeleteMode, BulletSource, PushOp, SuggestionPayload } from '@bullet/core'
import { and, eq } from 'drizzle-orm'
import type { PhoneDb } from './db'
import { ENTITY_TABLES } from './mirror'
import { audioAttachments, bullets, outbox, suggestions, transcripts } from './schema'

/** Injected so pure logic stays testable: the device clock, UUIDs and time zone. */
export interface LocalDeps {
  now: () => number
  uuid: () => string
  timezone: () => string
}

function appendOp(
  db: PhoneDb,
  op: PushOp,
  refs: { bullet_id?: string; suggestion_id?: string },
  now: number,
) {
  db.insert(outbox)
    .values({
      op_id: op.op_id,
      type: op.type,
      bullet_id: refs.bullet_id ?? null,
      suggestion_id: refs.suggestion_id ?? null,
      op,
      created_at: now,
    })
    .run()
}

export interface CaptureInput {
  text: string
  source?: BulletSource
}

/** Save a capture on the device (status `saved_local`) and queue it for sync. Returns its id. */
export function captureBullet(db: PhoneDb, input: CaptureInput, deps: LocalDeps): string {
  const text = input.text.trim()
  if (text === '') throw new Error('cannot capture an empty bullet')
  const now = deps.now()
  const id = deps.uuid()
  const bullet = {
    id,
    text,
    captured_at: now,
    timezone: deps.timezone(),
    source: input.source ?? 'text',
  }
  db.transaction((tx) => {
    tx.insert(bullets)
      .values({ ...bullet, created_at: now, updated_at: now })
      .run()
    appendOp(tx, { op_id: deps.uuid(), type: 'bullet.create', bullet }, { bullet_id: id }, now)
  })
  return id
}

export interface VoiceCaptureInput {
  /** What the user sends: the live draft, or their edit of it. */
  text: string
  /** True when the user changed the draft before sending: the server transcript won't replace it. */
  textEditedByUser: boolean
  /** The recording, already written to a file by the recorder. */
  audio: {
    localPath: string
    mimeType: string
    durationMs: number
    sizeBytes: number
    sha256: string | null
  }
  /** The live on-device transcript (Apple SpeechAnalyzer). */
  draft: { text: string; engine: string; model: string | null; languages: string[] }
}

/**
 * Save a voice capture: the bullet, its recording (kept permanently), the device draft transcript
 * and the outbox op — all in one transaction. The audio bytes upload after the op is acked.
 */
export function captureVoiceBullet(db: PhoneDb, input: VoiceCaptureInput, deps: LocalDeps): string {
  const text = input.text.trim()
  if (text === '') throw new Error('cannot capture an empty bullet')
  const now = deps.now()
  const id = deps.uuid()
  const audioId = deps.uuid()
  const a = input.audio
  const bullet = {
    id,
    text,
    captured_at: now,
    timezone: deps.timezone(),
    source: 'voice' as const,
    text_edited_by_user: input.textEditedByUser,
  }
  db.transaction((tx) => {
    tx.insert(bullets)
      .values({ ...bullet, created_at: now, updated_at: now })
      .run()
    tx.insert(audioAttachments)
      .values({
        id: audioId,
        bullet_id: id,
        mime_type: a.mimeType,
        duration_ms: a.durationMs,
        size_bytes: a.sizeBytes,
        sha256: a.sha256,
        local_path: a.localPath,
        upload_status: 'pending',
        created_at: now,
        updated_at: now,
      })
      .run()
    tx.insert(transcripts)
      .values({
        id: deps.uuid(),
        bullet_id: id,
        attachment_id: audioId,
        kind: 'device_draft',
        ...input.draft,
        transcribed_at: now,
        created_at: now,
        updated_at: now,
      })
      .run()
    appendOp(
      tx,
      {
        op_id: deps.uuid(),
        type: 'bullet.create',
        bullet: {
          ...bullet,
          audio: {
            id: audioId,
            mime_type: a.mimeType,
            duration_ms: a.durationMs,
            size_bytes: a.sizeBytes,
            sha256: a.sha256,
            draft: input.draft,
          },
        },
      },
      { bullet_id: id },
      now,
    )
  })
  return id
}

export function editBullet(db: PhoneDb, bulletId: string, text: string, deps: LocalDeps): void {
  const next = text.trim()
  if (next === '') throw new Error('cannot save an empty bullet')
  const now = deps.now()
  db.transaction((tx) => {
    tx.update(bullets)
      .set({ text: next, text_edited_by_user: true, updated_at: now, sync_rejection: null })
      .where(eq(bullets.id, bulletId))
      .run()
    appendOp(
      tx,
      { op_id: deps.uuid(), type: 'bullet.edit', bullet_id: bulletId, text: next, edited_at: now },
      { bullet_id: bulletId },
      now,
    )
  })
}

/** Soft-delete locally (mirroring what the server will do) and queue the delete. */
export function deleteBullet(
  db: PhoneDb,
  bulletId: string,
  mode: BulletDeleteMode,
  deps: LocalDeps,
): void {
  const now = deps.now()
  db.transaction((tx) => {
    tx.update(bullets)
      .set({ state: 'deleted', updated_at: now })
      .where(eq(bullets.id, bulletId))
      .run()
    // The recording + transcripts go with the bullet (soft delete; the file is kept).
    tx.update(audioAttachments)
      .set({ state: 'deleted', updated_at: now })
      .where(eq(audioAttachments.bullet_id, bulletId))
      .run()
    tx.update(transcripts)
      .set({ state: 'deleted', updated_at: now })
      .where(eq(transcripts.bullet_id, bulletId))
      .run()
    const own = eq(suggestions.source_bullet_id, bulletId)
    tx.update(suggestions)
      .set({ state: 'deleted', updated_at: now })
      .where(mode === 'cascade' ? own : and(own, eq(suggestions.status, 'pending')))
      .run()
    if (mode === 'cascade') {
      for (const table of Object.values(ENTITY_TABLES)) {
        tx.update(table)
          .set({ state: 'deleted', updated_at: now })
          .where(eq(table.source_bullet_id, bulletId))
          .run()
      }
    }
    appendOp(
      tx,
      { op_id: deps.uuid(), type: 'bullet.delete', bullet_id: bulletId, mode },
      { bullet_id: bulletId },
      now,
    )
  })
}

export function retryBullet(db: PhoneDb, bulletId: string, deps: LocalDeps): void {
  const now = deps.now()
  db.transaction((tx) => {
    appendOp(
      tx,
      { op_id: deps.uuid(), type: 'bullet.retry', bullet_id: bulletId },
      { bullet_id: bulletId },
      now,
    )
  })
}

export function acceptSuggestion(
  db: PhoneDb,
  suggestionId: string,
  deps: LocalDeps,
  payload?: SuggestionPayload,
): void {
  const now = deps.now()
  db.transaction((tx) => {
    tx.update(suggestions)
      .set({
        status: payload ? 'edited' : 'accepted',
        resolved_at: now,
        updated_at: now,
        ...(payload ? { payload } : {}),
      })
      .where(eq(suggestions.id, suggestionId))
      .run()
    appendOp(
      tx,
      {
        op_id: deps.uuid(),
        type: 'suggestion.accept',
        suggestion_id: suggestionId,
        ...(payload ? { payload } : {}),
      },
      { suggestion_id: suggestionId },
      now,
    )
  })
}

export function rejectSuggestion(db: PhoneDb, suggestionId: string, deps: LocalDeps): void {
  const now = deps.now()
  db.transaction((tx) => {
    tx.update(suggestions)
      .set({ status: 'rejected', resolved_at: now, updated_at: now })
      .where(eq(suggestions.id, suggestionId))
      .run()
    appendOp(
      tx,
      { op_id: deps.uuid(), type: 'suggestion.reject', suggestion_id: suggestionId },
      { suggestion_id: suggestionId },
      now,
    )
  })
}

/** Undo an applied (typically auto-applied) suggestion. */
export function undoSuggestion(db: PhoneDb, suggestionId: string, deps: LocalDeps): void {
  const now = deps.now()
  db.transaction((tx) => {
    const s = tx.select().from(suggestions).where(eq(suggestions.id, suggestionId)).get()
    if (s?.applied_entity_id && s.operation !== 'update') {
      const table = ENTITY_TABLES[s.target_kind]
      tx.update(table)
        .set({ state: 'deleted', updated_at: now })
        .where(eq(table.id, s.applied_entity_id))
        .run()
    }
    tx.update(suggestions)
      .set({
        status: 'rejected',
        resolved_at: now,
        applied_entity_id: null,
        applied_at: null,
        updated_at: now,
      })
      .where(eq(suggestions.id, suggestionId))
      .run()
    appendOp(
      tx,
      { op_id: deps.uuid(), type: 'suggestion.undo', suggestion_id: suggestionId },
      { suggestion_id: suggestionId },
      now,
    )
  })
}
