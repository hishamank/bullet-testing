/**
 * Change tracking for `GET /sync/pull`. Every write to a synced entity calls {@link touch}, which
 * moves the entity's row in `sync_changes` to a fresh sequence number; a pull reads entities whose
 * latest change is after the cursor and returns their CURRENT rows. The cursor is that sequence
 * number, rendered as an opaque string.
 */

import type { PullChangeKind, PullChanges } from '@bullet/core'
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import {
  isHiddenTheme,
  toAudioAttachment,
  toNoticedCard,
  toSuggestion,
  toSyncedBullet,
  toTheme,
  toThemeThought,
  toThought,
  toThoughtLink,
} from '../db/rows'
import {
  activities,
  audioAttachments,
  bullets,
  events,
  noticedCards,
  questions,
  suggestions,
  themes,
  themeThoughts,
  thoughtLinks,
  syncChanges,
  syncCounter,
  tasks,
  trackerEntries,
  thoughts,
  trackers,
  transcripts,
} from '../db/schema'

/** Record that `kind`/`id` changed. Call inside the same transaction as the write. */
export function touch(db: Db, ownerId: string, kind: PullChangeKind, id: string): void {
  const [row] = db
    .insert(syncCounter)
    .values({ id: 1, seq: 1 })
    .onConflictDoUpdate({ target: syncCounter.id, set: { seq: sql`${syncCounter.seq} + 1` } })
    .returning({ seq: syncCounter.seq })
    .all()
  const seq = row?.seq ?? 0
  db.insert(syncChanges)
    .values({ owner_id: ownerId, kind, entity_id: id, seq })
    .onConflictDoUpdate({
      target: [syncChanges.owner_id, syncChanges.kind, syncChanges.entity_id],
      set: { seq },
    })
    .run()
}

export class InvalidCursorError extends Error {}

/** Parse an opaque cursor; absent means "from the beginning". */
export function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === '') return 0
  if (!/^\d{1,15}$/.test(cursor)) throw new InvalidCursorError(`invalid cursor: ${cursor}`)
  return Number(cursor)
}

const emptyChanges = (): PullChanges => ({
  bullets: [],
  suggestions: [],
  tasks: [],
  events: [],
  trackers: [],
  tracker_entries: [],
  activities: [],
  audio_attachments: [],
  transcripts: [],
  thoughts: [],
  questions: [],
  thought_links: [],
  themes: [],
  theme_thoughts: [],
  noticed_cards: [],
})

/** Which of these thoughts are sensitive (server-only; decides what may leave the server). */
function sensitiveAmong(db: Db, ids: readonly string[]): Set<string> {
  if (ids.length === 0) return new Set()
  return new Set(
    db
      .select({ id: thoughts.id })
      .from(thoughts)
      .where(and(inArray(thoughts.id, [...new Set(ids)]), eq(thoughts.sensitive, true)))
      .all()
      .map((r) => r.id),
  )
}

/** Themes too sensitive to surface, among these. */
function hiddenThemes(db: Db, ids: readonly string[]): Set<string> {
  if (ids.length === 0) return new Set()
  return new Set(
    db
      .select({ id: themes.id, sensitive_share: themes.sensitive_share })
      .from(themes)
      .where(inArray(themes.id, [...new Set(ids)]))
      .all()
      .filter(isHiddenTheme)
      .map((r) => r.id),
  )
}

/** Load the current rows for `ids` of one kind, already in contract shape. */
function loadRows(db: Db, ownerId: string, kind: PullChangeKind, ids: string[], out: PullChanges) {
  switch (kind) {
    case 'bullets':
      out.bullets.push(
        ...db
          .select()
          .from(bullets)
          .where(and(eq(bullets.owner_id, ownerId), inArray(bullets.id, ids)))
          .all()
          .map(toSyncedBullet),
      )
      return
    case 'suggestions':
      out.suggestions.push(
        ...db
          .select()
          .from(suggestions)
          .where(and(eq(suggestions.owner_id, ownerId), inArray(suggestions.id, ids)))
          .all()
          .map(toSuggestion),
      )
      return
    case 'tasks':
      out.tasks.push(
        ...db
          .select()
          .from(tasks)
          .where(and(eq(tasks.owner_id, ownerId), inArray(tasks.id, ids)))
          .all(),
      )
      return
    case 'events':
      out.events.push(
        ...db
          .select()
          .from(events)
          .where(and(eq(events.owner_id, ownerId), inArray(events.id, ids)))
          .all(),
      )
      return
    case 'trackers':
      out.trackers.push(
        ...db
          .select()
          .from(trackers)
          .where(and(eq(trackers.owner_id, ownerId), inArray(trackers.id, ids)))
          .all(),
      )
      return
    case 'tracker_entries':
      out.tracker_entries.push(
        ...db
          .select()
          .from(trackerEntries)
          .where(and(eq(trackerEntries.owner_id, ownerId), inArray(trackerEntries.id, ids)))
          .all(),
      )
      return
    case 'activities':
      out.activities.push(
        ...db
          .select()
          .from(activities)
          .where(and(eq(activities.owner_id, ownerId), inArray(activities.id, ids)))
          .all(),
      )
      return
    case 'audio_attachments':
      out.audio_attachments.push(
        ...db
          .select()
          .from(audioAttachments)
          .where(and(eq(audioAttachments.owner_id, ownerId), inArray(audioAttachments.id, ids)))
          .all()
          .map(toAudioAttachment),
      )
      return
    case 'transcripts':
      out.transcripts.push(
        ...db
          .select()
          .from(transcripts)
          .where(and(eq(transcripts.owner_id, ownerId), inArray(transcripts.id, ids)))
          .all(),
      )
      return
    case 'thoughts':
      out.thoughts.push(
        ...db
          .select()
          .from(thoughts)
          .where(and(eq(thoughts.owner_id, ownerId), inArray(thoughts.id, ids)))
          .all()
          .map(toThought),
      )
      return
    case 'questions':
      out.questions.push(
        ...db
          .select()
          .from(questions)
          .where(and(eq(questions.owner_id, ownerId), inArray(questions.id, ids)))
          .all(),
      )
      return
    case 'thought_links': {
      const rows = db
        .select()
        .from(thoughtLinks)
        .where(and(eq(thoughtLinks.owner_id, ownerId), inArray(thoughtLinks.id, ids)))
        .all()
      const sensitive = sensitiveAmong(
        db,
        rows.flatMap((r) => [r.a_thought_id, r.b_thought_id]),
      )
      out.thought_links.push(...rows.map((r) => toThoughtLink(r, sensitive)))
      return
    }
    case 'themes':
      out.themes.push(
        ...db
          .select()
          .from(themes)
          .where(and(eq(themes.owner_id, ownerId), inArray(themes.id, ids)))
          .all()
          .map(toTheme),
      )
      return
    case 'theme_thoughts': {
      const rows = db
        .select()
        .from(themeThoughts)
        .where(and(eq(themeThoughts.owner_id, ownerId), inArray(themeThoughts.id, ids)))
        .all()
      const sensitive = sensitiveAmong(
        db,
        rows.map((r) => r.thought_id),
      )
      const hidden = hiddenThemes(
        db,
        rows.map((r) => r.theme_id),
      )
      out.theme_thoughts.push(
        ...rows.map((r) =>
          toThemeThought(r, sensitive.has(r.thought_id) || hidden.has(r.theme_id)),
        ),
      )
      return
    }
    case 'noticed_cards': {
      const rows = db
        .select()
        .from(noticedCards)
        .where(and(eq(noticedCards.owner_id, ownerId), inArray(noticedCards.id, ids)))
        .all()
      const sensitive = sensitiveAmong(
        db,
        rows.flatMap((r) => r.quotes.map((q) => q.thought_id)),
      )
      const hidden = hiddenThemes(
        db,
        rows.map((r) => r.theme_id),
      )
      out.noticed_cards.push(
        ...rows.map((r) => toNoticedCard(r, sensitive, hidden.has(r.theme_id))),
      )
      return
    }
    default: {
      const never: never = kind
      throw new Error(`unknown change kind ${String(never)}`)
    }
  }
}

export interface PullPage {
  changes: PullChanges
  cursor: string
  has_more: boolean
}

/** One page of changes after `cursor`, read in a single transaction (a consistent snapshot). */
export function pullChanges(db: Db, ownerId: string, cursor: number, limit: number): PullPage {
  return db.transaction((tx) => {
    const rows = tx
      .select()
      .from(syncChanges)
      .where(and(eq(syncChanges.owner_id, ownerId), gt(syncChanges.seq, cursor)))
      .orderBy(asc(syncChanges.seq))
      .limit(limit + 1)
      .all()
    const page = rows.slice(0, limit)
    const byKind = new Map<PullChangeKind, string[]>()
    for (const r of page) {
      const kind = r.kind as PullChangeKind
      byKind.set(kind, [...(byKind.get(kind) ?? []), r.entity_id])
    }
    const changes = emptyChanges()
    for (const [kind, ids] of byKind) loadRows(tx, ownerId, kind, ids, changes)
    const last = page.at(-1)
    return {
      changes,
      cursor: String(last ? last.seq : cursor),
      has_more: rows.length > limit,
    }
  })
}
