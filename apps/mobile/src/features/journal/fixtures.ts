/** Vitest-only: made-up journal rows written straight into the phone mirror. */

import type { ThoughtKind, TrackerConfig, TrackerEntryValue } from '@bullet/core'
import { randomUUID } from 'node:crypto'
import type { PhoneDb } from '../../data/db'
import {
  activities,
  audioAttachments,
  bullets,
  events,
  suggestions,
  tasks,
  thoughts,
  trackerEntries,
  trackers,
  transcripts,
} from '../../data/schema'

export const TZ = 'Europe/Paris'
const row = (at: number) => ({ id: randomUUID(), created_at: at, updated_at: at })

export function seedBullet(
  db: PhoneDb,
  at: number,
  over: Partial<typeof bullets.$inferInsert> = {},
): string {
  const r = { ...row(at), ...over }
  db.insert(bullets)
    .values({
      text: 'a made-up capture',
      captured_at: at,
      timezone: TZ,
      source: 'text',
      server_status: 'processed',
      ...r,
    })
    .run()
  return r.id
}

export function seedThought(
  db: PhoneDb,
  bulletId: string,
  position: number,
  kind: ThoughtKind,
  text: string,
  over: Partial<typeof thoughts.$inferInsert> = {},
): string {
  const r = { ...row(1), ...over }
  db.insert(thoughts)
    .values({ source_bullet_id: bulletId, position, kind, kind_source: 'engine', text, ...r })
    .run()
  return r.id
}

export function seedAudio(
  db: PhoneDb,
  bulletId: string,
  over: Partial<typeof audioAttachments.$inferInsert> = {},
): string {
  const r = { ...row(1), ...over }
  db.insert(audioAttachments)
    .values({
      bullet_id: bulletId,
      mime_type: 'audio/mp4',
      duration_ms: 192_000,
      size_bytes: 1000,
      upload_status: 'uploaded',
      ...r,
    })
    .run()
  return r.id
}

export function seedTranscript(
  db: PhoneDb,
  bulletId: string,
  attachmentId: string,
  kind: 'device_draft' | 'server',
  text: string,
) {
  db.insert(transcripts)
    .values({
      ...row(1),
      bullet_id: bulletId,
      attachment_id: attachmentId,
      kind,
      text,
      engine: kind === 'server' ? 'whisper.cpp' : 'apple',
      languages: [],
      transcribed_at: kind === 'server' ? 2 : 1,
    })
    .run()
}

export function seedSuggestion(
  db: PhoneDb,
  bulletId: string,
  over: Partial<typeof suggestions.$inferInsert> &
    Pick<typeof suggestions.$inferInsert, 'target_kind' | 'payload'>,
): string {
  const r = { ...row(1), ...over }
  db.insert(suggestions)
    .values({
      source_bullet_id: bulletId,
      operation: 'create',
      confidence: 0.9,
      tier: 'suggest',
      status: 'pending',
      auto_applied: false,
      ...r,
    })
    .run()
  return r.id
}

export function seedTask(db: PhoneDb, over: Partial<typeof tasks.$inferInsert> = {}): string {
  const r = { ...row(1), ...over }
  db.insert(tasks)
    .values({ status: 'todo', title: 'a made-up task', ...r })
    .run()
  return r.id
}

export function seedEvent(
  db: PhoneDb,
  startsAt: number,
  over: Partial<typeof events.$inferInsert> = {},
): string {
  const r = { ...row(1), ...over }
  db.insert(events)
    .values({ title: 'a made-up event', starts_at: startsAt, all_day: false, ...r })
    .run()
  return r.id
}

export function seedTracker(db: PhoneDb, name: string, config: TrackerConfig): string {
  const r = row(1)
  db.insert(trackers)
    .values({ ...r, name, input_type: config.input_type, config })
    .run()
  return r.id
}

export function seedEntry(
  db: PhoneDb,
  trackerId: string,
  value: TrackerEntryValue,
  at: number,
): string {
  const r = row(at)
  db.insert(trackerEntries)
    .values({ ...r, tracker_id: trackerId, value, logged_at: at })
    .run()
  return r.id
}

export function seedActivity(
  db: PhoneDb,
  name: string,
  at: number,
  over: Partial<typeof activities.$inferInsert> = {},
): string {
  const r = { ...row(at), ...over }
  db.insert(activities)
    .values({ name, occurred_at: at, ...r })
    .run()
  return r.id
}
