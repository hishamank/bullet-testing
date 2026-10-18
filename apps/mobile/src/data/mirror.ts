/**
 * Merging a pull into the local mirror. Server rows replace local ones — except where the user
 * has a change still in the outbox: then the local version wins until the server acknowledges it
 * (only the server's processing fields are taken for such a bullet). Runs in one transaction with
 * the cursor update, so a crash can never skip or half-apply a page.
 */

import type { PullResponse, SyncedBullet, TargetKind } from '@bullet/core'
import { eq, isNotNull } from 'drizzle-orm'
import type { PhoneDb } from './db'
import {
  activities,
  audioAttachments,
  bullets,
  events,
  outbox,
  suggestions,
  syncState,
  tasks,
  trackerEntries,
  trackers,
  transcripts,
} from './schema'

export const ENTITY_TABLES = {
  task: tasks,
  event: events,
  tracker: trackers,
  tracker_entry: trackerEntries,
  activity: activities,
} as const satisfies Record<TargetKind, unknown>

export const CURSOR_KEY = 'pull_cursor'

export function getState(db: PhoneDb, key: string): string | undefined {
  return db.select().from(syncState).where(eq(syncState.key, key)).get()?.value
}

export function setState(db: PhoneDb, key: string, value: string): void {
  db.insert(syncState)
    .values({ key, value })
    .onConflictDoUpdate({ target: syncState.key, set: { value } })
    .run()
}

const serverProcessing = (b: SyncedBullet) => ({
  server_status: b.processing.status,
  server_attempts: b.processing.attempts,
  server_error_code: b.processing.error?.code ?? null,
  server_error_message: b.processing.error?.message ?? null,
  server_next_retry_at: b.processing.next_retry_at,
})

/** Drop the server-only owner field from a pulled row. */
function local<T extends { owner_id: string }>(row: T): Omit<T, 'owner_id'> {
  const { owner_id, ...rest } = row
  void owner_id
  return rest
}

function upsert(db: PhoneDb, table: typeof tasks, rows: { id: string }[]): void {
  for (const row of rows) {
    const values = row as typeof tasks.$inferInsert
    db.insert(table).values(values).onConflictDoUpdate({ target: table.id, set: values }).run()
  }
}

export function applyPull(db: PhoneDb, page: PullResponse): void {
  db.transaction((tx) => {
    const pending = tx
      .select({ bullet_id: outbox.bullet_id, suggestion_id: outbox.suggestion_id })
      .from(outbox)
      .all()
    const pendingBullets = new Set(pending.map((p) => p.bullet_id).filter(Boolean))
    const pendingSuggestions = new Set(pending.map((p) => p.suggestion_id).filter(Boolean))

    for (const b of page.changes.bullets) {
      const proc = serverProcessing(b)
      if (pendingBullets.has(b.id)) {
        tx.update(bullets).set(proc).where(eq(bullets.id, b.id)).run()
        continue
      }
      const row = { ...local(b), ...proc }
      const { processing, ...values } = row
      void processing
      tx.insert(bullets)
        .values(values)
        .onConflictDoUpdate({ target: bullets.id, set: values })
        .run()
    }

    for (const s of page.changes.suggestions) {
      if (pendingSuggestions.has(s.id)) continue
      const row = local(s)
      tx.insert(suggestions)
        .values(row)
        .onConflictDoUpdate({ target: suggestions.id, set: row })
        .run()
    }

    // The generic upsert treats every mirror table alike (same id/state/timestamps columns).
    const t = (table: unknown) => table as typeof tasks
    upsert(tx, tasks, page.changes.tasks.map(local))
    upsert(tx, t(events), page.changes.events.map(local))
    upsert(tx, t(trackers), page.changes.trackers.map(local))
    upsert(tx, t(trackerEntries), page.changes.tracker_entries.map(local))
    upsert(tx, t(activities), page.changes.activities.map(local))

    // Recordings: the server's view of the upload wins; the local file path is ours to keep.
    for (const a of page.changes.audio_attachments) {
      const row = local(a)
      tx.insert(audioAttachments)
        .values({ ...row, local_path: null })
        .onConflictDoUpdate({ target: audioAttachments.id, set: row })
        .run()
    }
    for (const t of page.changes.transcripts) {
      const row = local(t)
      tx.insert(transcripts)
        .values(row)
        .onConflictDoUpdate({ target: transcripts.id, set: row })
        .run()
    }

    setState(tx, CURSOR_KEY, page.cursor)
  })
}

/** Ids of bullets with an unsent capture/edit/retry — they show `saved_local`. */
export function bulletsWithPendingChanges(db: PhoneDb): Set<string> {
  const rows = db
    .select({ bullet_id: outbox.bullet_id, type: outbox.type })
    .from(outbox)
    .where(isNotNull(outbox.bullet_id))
    .all()
  return new Set(rows.filter((r) => r.type !== 'bullet.delete').map((r) => r.bullet_id as string))
}
