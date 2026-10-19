/**
 * Merging a pull into the local mirror. Server rows replace local ones — except where the user
 * has a change still in the outbox: then the local version wins until the server acknowledges it
 * (only the server's processing fields are taken for such a bullet). That covers hand edits of
 * tasks, events and tracker entries too (the outbox's `entity_id`). Runs in one transaction with
 * the cursor update, so a crash can never skip or half-apply a page.
 */

import type { PullResponse, SyncedBullet, ThingKind } from '@bullet/core'
import { eq, isNotNull } from 'drizzle-orm'
import type { PhoneDb } from './db'
import {
  activities,
  audioAttachments,
  bullets,
  events,
  noticedCards,
  outbox,
  suggestions,
  syncState,
  tasks,
  themes,
  themeThoughts,
  thoughtLinks,
  trackerEntries,
  questions,
  thoughts,
  trackers,
  transcripts,
} from './schema'

export const ENTITY_TABLES = {
  task: tasks,
  event: events,
  tracker: trackers,
  tracker_entry: trackerEntries,
  activity: activities,
} as const satisfies Record<ThingKind, unknown>

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

function upsert(
  db: PhoneDb,
  table: typeof tasks,
  rows: { id: string }[],
  pending: Set<unknown> = new Set(),
): void {
  for (const row of rows) {
    if (pending.has(row.id)) continue
    const values = row as typeof tasks.$inferInsert
    db.insert(table).values(values).onConflictDoUpdate({ target: table.id, set: values }).run()
  }
}

export function applyPull(db: PhoneDb, page: PullResponse): void {
  db.transaction((tx) => {
    const pending = tx
      .select({
        bullet_id: outbox.bullet_id,
        suggestion_id: outbox.suggestion_id,
        thought_id: outbox.thought_id,
        question_id: outbox.question_id,
        entity_id: outbox.entity_id,
      })
      .from(outbox)
      .all()
    const pendingBullets = new Set(pending.map((p) => p.bullet_id).filter(Boolean))
    const pendingSuggestions = new Set(pending.map((p) => p.suggestion_id).filter(Boolean))
    const pendingThoughts = new Set(pending.map((p) => p.thought_id).filter(Boolean))
    const pendingQuestions = new Set(pending.map((p) => p.question_id).filter(Boolean))
    const pendingEntities = new Set(pending.map((p) => p.entity_id).filter(Boolean))

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
    upsert(tx, tasks, page.changes.tasks.map(local), pendingEntities)
    upsert(tx, t(events), page.changes.events.map(local), pendingEntities)
    upsert(tx, t(trackers), page.changes.trackers.map(local), pendingEntities)
    upsert(tx, t(trackerEntries), page.changes.tracker_entries.map(local), pendingEntities)
    upsert(tx, t(activities), page.changes.activities.map(local), pendingEntities)

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

    // Thoughts and questions: local re-classify/resolve/dismiss/answer wins until acknowledged.
    for (const t of page.changes.thoughts) {
      if (pendingThoughts.has(t.id)) continue
      const { span, ...rest } = local(t)
      const row = { ...rest, span_start: span?.start ?? null, span_end: span?.end ?? null }
      tx.insert(thoughts).values(row).onConflictDoUpdate({ target: thoughts.id, set: row }).run()
    }
    for (const q of page.changes.questions) {
      if (pendingQuestions.has(q.id)) continue
      const row = local(q)
      tx.insert(questions).values(row).onConflictDoUpdate({ target: questions.id, set: row }).run()
    }

    // Connections (slice 3): a local "Not related", rename, retire, merge, open or dismiss wins
    // until the server has it (its op carries the link / theme / card id as `entity_id`).
    upsert(tx, t(thoughtLinks), page.changes.thought_links.map(local), pendingEntities)
    upsert(tx, t(themes), page.changes.themes.map(local), pendingEntities)
    upsert(tx, t(themeThoughts), page.changes.theme_thoughts.map(local), pendingEntities)
    upsert(tx, t(noticedCards), page.changes.noticed_cards.map(local), pendingEntities)

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
