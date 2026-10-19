/**
 * Read models for slice 3 (connections, themes, Noticed), for the UI pass. Pure functions over the
 * local mirror. Writes are in `local.ts` (`vetoLink`, `renameTheme`, `retireTheme`, `mergeTheme`,
 * `openNoticed`, `dismissNoticed`, `answerConnection`; a "Did this close it?" is decided with
 * `acceptSuggestion` / `rejectSuggestion` / `undoSuggestion`).
 *
 * Nothing here counts toward the Inbox badge, and nothing here notifies.
 */

import type { LinkType, NoticedQuote } from '@bullet/core'
import { and, eq, inArray, ne, or } from 'drizzle-orm'
import type { PhoneDb } from './db'
import {
  bullets,
  noticedCards,
  suggestions,
  themes,
  themeThoughts,
  thoughtLinks,
  thoughts,
} from './schema'

type ThoughtRow = typeof thoughts.$inferSelect
type SuggestionRow = typeof suggestions.$inferSelect
type ThemeRow = typeof themes.$inferSelect

/** The small word a Related row carries. */
export const RELATED_WORDS: Record<LinkType, string> = {
  same_entity: 'same person',
  same_topic: 'related',
  answers: 'answers',
  revisits: 'again',
}

export interface RelatedRow {
  linkId: string
  type: LinkType
  word: string
  /** This capture's thought the link starts from. */
  thoughtId: string
  /** The other capture: open it on tap. */
  other: { bulletId: string; thoughtId: string; text: string; capturedAt: number }
}

/**
 * "Related · N" on a capture: the thoughts of other captures linked to its thoughts, newest
 * capture first, one row per link. Long-press a row for Not related (`vetoLink`).
 */
export function listRelated(db: PhoneDb, bulletId: string): RelatedRow[] {
  const links = db
    .select()
    .from(thoughtLinks)
    .where(
      and(
        eq(thoughtLinks.state, 'active'),
        or(eq(thoughtLinks.a_bullet_id, bulletId), eq(thoughtLinks.b_bullet_id, bulletId)),
      ),
    )
    .all()
  if (links.length === 0) return []
  const ids = [...new Set(links.flatMap((l) => [l.a_thought_id, l.b_thought_id]))]
  const ts = new Map(
    db
      .select()
      .from(thoughts)
      .where(and(inArray(thoughts.id, ids), eq(thoughts.state, 'active')))
      .all()
      .map((t) => [t.id, t]),
  )
  const bulletIds = [...new Set([...ts.values()].map((t) => t.source_bullet_id))]
  const captured = new Map(
    db
      .select({ id: bullets.id, at: bullets.captured_at })
      .from(bullets)
      .where(and(inArray(bullets.id, bulletIds), eq(bullets.state, 'active')))
      .all()
      .map((b) => [b.id, b.at]),
  )
  const rows: RelatedRow[] = []
  for (const l of links) {
    const mineIsA = l.a_bullet_id === bulletId
    const mine = ts.get(mineIsA ? l.a_thought_id : l.b_thought_id)
    const other = ts.get(mineIsA ? l.b_thought_id : l.a_thought_id)
    const at = other ? captured.get(other.source_bullet_id) : undefined
    if (!mine || !other || at === undefined) continue
    rows.push({
      linkId: l.id,
      type: l.type,
      word: RELATED_WORDS[l.type],
      thoughtId: mine.id,
      other: {
        bulletId: other.source_bullet_id,
        thoughtId: other.id,
        text: other.text,
        capturedAt: at,
      },
    })
  }
  return rows.sort((a, b) => b.other.capturedAt - a.other.capturedAt)
}

export interface NoticedView {
  id: string
  headline: string
  /** Each opens its capture (quotes of deleted captures are left out). */
  quotes: NoticedQuote[]
  count: number
  days: number
  status: 'new' | 'opened'
  createdAt: number
  /** The editable pill: rename / merge with… / not a theme. */
  theme: { id: string; name: string | null; namedByUser: boolean }
}

/**
 * The Inbox's Noticed section (below Questions): cards not dismissed or retired, newest first.
 * Never counted in the badge. Retiring a card left unopened for 14 days is the server's job.
 */
export function listNoticed(db: PhoneDb): NoticedView[] {
  const cards = db
    .select()
    .from(noticedCards)
    .where(and(eq(noticedCards.state, 'active'), inArray(noticedCards.status, ['new', 'opened'])))
    .all()
  if (cards.length === 0) return []
  const th = new Map(
    db
      .select()
      .from(themes)
      .where(inArray(themes.id, [...new Set(cards.map((c) => c.theme_id))]))
      .all()
      .map((t) => [t.id, t]),
  )
  const live = new Set(
    db
      .select({ id: bullets.id })
      .from(bullets)
      .where(
        and(
          eq(bullets.state, 'active'),
          inArray(bullets.id, [...new Set(cards.flatMap((c) => c.quotes.map((q) => q.bullet_id)))]),
        ),
      )
      .all()
      .map((b) => b.id),
  )
  const out: NoticedView[] = []
  for (const c of cards) {
    const t = th.get(c.theme_id)
    if (!t || t.state !== 'active' || t.status === 'retired') continue
    const quotes = c.quotes.filter((q) => live.has(q.bullet_id))
    if (quotes.length === 0) continue
    out.push({
      id: c.id,
      headline: c.headline,
      quotes,
      count: c.count,
      days: c.days,
      status: c.status as 'new' | 'opened',
      createdAt: c.created_at,
      theme: { id: t.id, name: t.name, namedByUser: t.named_by_user },
    })
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

/** Themes still showing (active or dormant), biggest first: "Merge with…" offers these. */
export function listThemes(db: PhoneDb, exceptId?: string): ThemeRow[] {
  return db
    .select()
    .from(themes)
    .where(
      and(
        eq(themes.state, 'active'),
        ne(themes.status, 'retired'),
        ...(exceptId ? [ne(themes.id, exceptId)] : []),
      ),
    )
    .all()
    .sort(
      (a, b) => b.thought_count - a.thought_count || (b.last_seen_at ?? 0) - (a.last_seen_at ?? 0),
    )
}

/** The Stream's "again" dot: which of these thoughts belong to an active theme. */
export function thoughtsInThemes(db: PhoneDb, thoughtIds: readonly string[]): Set<string> {
  if (thoughtIds.length === 0) return new Set()
  const rows = db
    .select({ thought: themeThoughts.thought_id, theme: themeThoughts.theme_id })
    .from(themeThoughts)
    .where(
      and(eq(themeThoughts.state, 'active'), inArray(themeThoughts.thought_id, [...thoughtIds])),
    )
    .all()
  if (rows.length === 0) return new Set()
  const active = new Set(
    db
      .select({ id: themes.id })
      .from(themes)
      .where(
        and(
          eq(themes.state, 'active'),
          eq(themes.status, 'active'),
          inArray(themes.id, [...new Set(rows.map((r) => r.theme))]),
        ),
      )
      .all()
      .map((t) => t.id),
  )
  return new Set(rows.filter((r) => active.has(r.theme)).map((r) => r.thought))
}

export interface LoopAnswerView {
  suggestion: SuggestionRow
  /** The open loop: «loop». */
  loop: Pick<ThoughtRow, 'id' | 'text' | 'kind' | 'source_bullet_id' | 'resolved_at'>
  /** The thought that answers it: «answer», in the capture `suggestion.source_bullet_id`. */
  answer: Pick<ThoughtRow, 'id' | 'text' | 'source_bullet_id'> | null
  /** The loop was closed another way meanwhile: show "Already closed" (accepting is refused). */
  alreadyClosed: boolean
}

/**
 * "Did this close it? «loop» ← «answer»": `thought_resolve` suggestions, tier suggest, oldest
 * first. `status` picks the waiting ones (default) or the accepted ones ("Done for you", with
 * Undo via `undoSuggestion`).
 */
export function listLoopAnswers(
  db: PhoneDb,
  status: 'pending' | 'accepted' = 'pending',
): LoopAnswerView[] {
  const rows = db
    .select()
    .from(suggestions)
    .where(
      and(
        eq(suggestions.state, 'active'),
        eq(suggestions.target_kind, 'thought_resolve'),
        status === 'pending'
          ? eq(suggestions.status, 'pending')
          : inArray(suggestions.status, ['accepted', 'edited']),
      ),
    )
    .orderBy(suggestions.created_at)
    .all()
  if (rows.length === 0) return []
  const ids = rows
    .flatMap((s) => [s.target_id, s.source_thought_id])
    .filter((x): x is string => !!x)
  const ts = new Map(
    db
      .select()
      .from(thoughts)
      .where(and(inArray(thoughts.id, ids), eq(thoughts.state, 'active')))
      .all()
      .map((t) => [t.id, t]),
  )
  const out: LoopAnswerView[] = []
  for (const s of rows) {
    const loop = s.target_id ? ts.get(s.target_id) : undefined
    if (!loop) continue
    const answer = s.source_thought_id ? (ts.get(s.source_thought_id) ?? null) : null
    out.push({
      suggestion: s,
      loop,
      answer,
      alreadyClosed:
        status === 'pending' &&
        loop.resolved_at !== null &&
        loop.resolved_by_bullet_id !== s.source_bullet_id,
    })
  }
  return out
}
