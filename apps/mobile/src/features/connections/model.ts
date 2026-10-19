/**
 * Slice 3 on the phone's screens: Noticed cards, "Did this close it?", Related rows, the theme
 * screen, the Stream's "again" dot and "Merge with…". Queries over the local mirror (on top of
 * `data/connections.ts`) plus pure shaping, so every label is testable.
 *
 * Nothing here counts toward the Inbox badge, and nothing here notifies.
 */

import { zonedParts } from '@bullet/engine'
import { and, eq, inArray } from 'drizzle-orm'
import {
  listLoopAnswers,
  listNoticed,
  listRelated,
  listThemes,
  type RelatedRow,
  thoughtsInThemes,
} from '../../data/connections'
import type { PhoneDb } from '../../data/db'
import { bullets, themes, themeThoughts, thoughts } from '../../data/schema'
import { dayDiff } from '../journal/format'
import { textDirection } from '../reflect/direction'
import { COPY, quote } from './copy'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Today", "Yesterday", "Mon" (this past week), "2 Oct", "2 Oct 2025". */
export function dayWord(at: number, now: number, tz: string): string {
  const diff = dayDiff(at, now, tz)
  if (diff === 0) return 'Today'
  if (diff === -1) return 'Yesterday'
  const p = zonedParts(at, tz)
  if (diff < 0 && diff > -7) return WEEKDAYS[p.weekday] ?? ''
  const year = p.year !== zonedParts(now, tz).year ? ` ${p.year}` : ''
  return `${p.day} ${MONTHS[p.month - 1]}${year}`
}

/** True when the words read right to left (Arabic script). */
export const isRtl = (text: string) => textDirection(text) === 'rtl'

/** One of the user's thoughts, quoted, opening its capture. */
export interface QuoteRow {
  thoughtId: string
  bulletId: string
  text: string
  /** "Mon", "Today", "2 Oct" (in the zone it was captured in). */
  when: string
  rtl: boolean
  /** VoiceOver: "Mon: «…»". */
  label: string
}

function captured(db: PhoneDb, ids: readonly string[]) {
  if (ids.length === 0) return new Map<string, { at: number; tz: string; text: string }>()
  return new Map(
    db
      .select({
        id: bullets.id,
        at: bullets.captured_at,
        tz: bullets.timezone,
        text: bullets.text,
      })
      .from(bullets)
      .where(and(inArray(bullets.id, [...new Set(ids)]), eq(bullets.state, 'active')))
      .all()
      .map((b) => [b.id, { at: b.at, tz: b.tz, text: b.text }]),
  )
}

function quoteRow(
  q: { thoughtId: string; bulletId: string; text: string },
  at: { at: number; tz: string } | undefined,
  now: number,
): QuoteRow {
  const when = at ? dayWord(at.at, now, at.tz) : ''
  return {
    ...q,
    when,
    rtl: isRtl(q.text),
    label: when ? `${when}: ${quote(q.text)}` : quote(q.text),
  }
}

// ---- Inbox · Noticed ----

export interface NoticedCard {
  id: string
  /** "«quote» · came up N times in M days", as the server wrote it. */
  headline: string
  headlineRtl: boolean
  quotes: QuoteRow[]
  theme: { id: string; name: string | null }
  isNew: boolean
}

/** The Noticed section: cards still showing, newest first (never in the badge). */
export function loadNoticed(db: PhoneDb, now: number): NoticedCard[] {
  const cards = listNoticed(db)
  const at = captured(
    db,
    cards.flatMap((c) => c.quotes.map((q) => q.bullet_id)),
  )
  return cards.map((c) => ({
    id: c.id,
    headline: c.headline,
    // The headline starts with the quote: lay it out the way the quote reads.
    headlineRtl: isRtl(c.headline),
    quotes: c.quotes
      .slice(0, 3)
      .map((q) =>
        quoteRow(
          { thoughtId: q.thought_id, bulletId: q.bullet_id, text: q.text },
          at.get(q.bullet_id),
          now,
        ),
      ),
    theme: { id: c.theme.id, name: c.theme.name },
    isNew: c.status === 'new',
  }))
}

/** One theme offered by "Merge with…". */
export interface MergeChoice {
  id: string
  /** Its name, or one of its thoughts quoted when it has none. */
  title: string
  detail: string
}

/** Themes another theme can merge into: active or dormant ones, biggest first. */
export function mergeChoices(db: PhoneDb, themeId: string): MergeChoice[] {
  const rows = listThemes(db, themeId)
  if (rows.length === 0) return []
  const samples = new Map<string, string>()
  for (const r of db
    .select({ theme: themeThoughts.theme_id, text: thoughts.text, at: thoughts.created_at })
    .from(themeThoughts)
    .innerJoin(thoughts, eq(thoughts.id, themeThoughts.thought_id))
    .where(
      and(
        eq(themeThoughts.state, 'active'),
        eq(thoughts.state, 'active'),
        inArray(
          themeThoughts.theme_id,
          rows.map((t) => t.id),
        ),
      ),
    )
    .all()
    .sort((a, b) => b.at - a.at)) {
    if (!samples.has(r.theme)) samples.set(r.theme, r.text)
  }
  return rows.map((t) => {
    const sample = samples.get(t.id)
    return {
      id: t.id,
      title: t.name ?? (sample ? quote(sample) : COPY.unnamed),
      detail: t.thought_count === 1 ? '1 thought' : `${t.thought_count} thoughts`,
    }
  })
}

// ---- Theme screen ----

export interface ThemeView {
  id: string
  name: string | null
  /** Every thought of it still on the phone, newest capture first. */
  captures: QuoteRow[]
}

/** A theme and its captures; null when it isn't showing (retired, merged away, unknown). */
export function loadTheme(db: PhoneDb, themeId: string, now: number): ThemeView | null {
  const t = db.select().from(themes).where(eq(themes.id, themeId)).get()
  if (!t || t.state !== 'active' || t.status === 'retired') return null
  const rows = db
    .select({
      thoughtId: thoughts.id,
      bulletId: thoughts.source_bullet_id,
      text: thoughts.text,
      at: bullets.captured_at,
      tz: bullets.timezone,
      position: thoughts.position,
    })
    .from(themeThoughts)
    .innerJoin(thoughts, eq(thoughts.id, themeThoughts.thought_id))
    .innerJoin(bullets, eq(bullets.id, thoughts.source_bullet_id))
    .where(
      and(
        eq(themeThoughts.theme_id, themeId),
        eq(themeThoughts.state, 'active'),
        eq(thoughts.state, 'active'),
        eq(bullets.state, 'active'),
      ),
    )
    .all()
    .sort((a, b) => b.at - a.at || a.position - b.position)
  return {
    id: t.id,
    name: t.name,
    captures: rows.map((r) =>
      quoteRow(
        { thoughtId: r.thoughtId, bulletId: r.bulletId, text: r.text },
        { at: r.at, tz: r.tz },
        now,
      ),
    ),
  }
}

// ---- Stream · the "again" dot ----

/** For thoughts in an active theme: which theme (the dot opens it). Others are left out. */
export function themeOfThoughts(db: PhoneDb, thoughtIds: readonly string[]): Map<string, string> {
  const inTheme = thoughtsInThemes(db, thoughtIds)
  if (inTheme.size === 0) return new Map()
  const active = new Set(
    db
      .select({ id: themes.id })
      .from(themes)
      .where(and(eq(themes.state, 'active'), eq(themes.status, 'active')))
      .all()
      .map((t) => t.id),
  )
  const out = new Map<string, string>()
  for (const r of db
    .select({ thought: themeThoughts.thought_id, theme: themeThoughts.theme_id })
    .from(themeThoughts)
    .where(and(eq(themeThoughts.state, 'active'), inArray(themeThoughts.thought_id, [...inTheme])))
    .all()) {
    if (active.has(r.theme) && !out.has(r.thought)) out.set(r.thought, r.theme)
  }
  return out
}

// ---- Inbox · To decide: "Did this close it?" ----

export interface LoopAnswerCard {
  suggestionId: string
  loop: string
  loopRtl: boolean
  loopBulletId: string
  /** The answering thought, or the answering capture's words when the thought is gone. */
  answer: string | null
  answerRtl: boolean
  answerBulletId: string
  /** The loop was closed another way meanwhile: "Already closed", then it goes. */
  alreadyClosed: boolean
}

/** "Did this close it? «loop» ← «answer»", oldest first. These count in the Inbox badge. */
export function loadLoopAnswers(db: PhoneDb): LoopAnswerCard[] {
  const views = listLoopAnswers(db)
  const missing = views.filter((v) => !v.answer).map((v) => v.suggestion.source_bullet_id)
  const fallback = captured(db, missing)
  return views.map((v) => {
    const answer = v.answer?.text ?? fallback.get(v.suggestion.source_bullet_id)?.text ?? null
    return {
      suggestionId: v.suggestion.id,
      loop: v.loop.text,
      loopRtl: isRtl(v.loop.text),
      loopBulletId: v.loop.source_bullet_id,
      answer,
      answerRtl: answer ? isRtl(answer) : false,
      answerBulletId: v.suggestion.source_bullet_id,
      alreadyClosed: v.alreadyClosed,
    }
  })
}

// ---- Capture detail · Related ----

export interface RelatedItem {
  linkId: string
  bulletId: string
  text: string
  rtl: boolean
  /** "Mon · same person". */
  meta: string
  /** VoiceOver: "Mon, same person: «…»". */
  label: string
}

export function relatedItems(rows: readonly RelatedRow[], now: number, tz: string): RelatedItem[] {
  return rows.map((r) => {
    const when = dayWord(r.other.capturedAt, now, tz)
    return {
      linkId: r.linkId,
      bulletId: r.other.bulletId,
      text: r.other.text,
      rtl: isRtl(r.other.text),
      meta: `${when} · ${r.word}`,
      label: `${when}, ${r.word}: ${quote(r.other.text)}`,
    }
  })
}

/** "Related · N" on a capture (`listRelated` already honours `visible_from`). */
export function loadRelated(db: PhoneDb, bulletId: string, now: number, tz: string): RelatedItem[] {
  return relatedItems(listRelated(db, bulletId), now, tz)
}

/** The whole Inbox is empty: nothing to decide, answer, think about, show or notice. */
export function inboxIsEmpty(baseEmpty: boolean, loopAnswers: number, noticed: number): boolean {
  return baseEmpty && loopAnswers === 0 && noticed === 0
}

/** A theme name as typed: one line, trimmed, at most 60 characters; null when empty. */
export function cleanThemeName(typed: string): string | null {
  const name = typed.replace(/\s+/g, ' ').trim().slice(0, 60).trim()
  return name === '' ? null : name
}
