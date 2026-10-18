/**
 * The Inbox read model: To decide (grouped by capture), Questions, Done for you today, and calm
 * notices for refused decisions. `buildInbox` is pure over plain rows; `loadInbox` fetches them.
 */

import type { BulletSource, SuggestionTier, TrackerConfig } from '@bullet/core'
import { zonedParts, zonedToEpoch } from '@bullet/engine'
import { and, eq, inArray } from 'drizzle-orm'
import type { PhoneDb } from '../../data/db'
import { listOpenQuestions, listPendingSuggestions } from '../../data/queries'
import { listRejections, type SyncRejection } from '../../data/rejections'
import { bullets, events, questions, suggestions, tasks, trackers } from '../../data/schema'
import { type Summary, type SummaryContext, snippet, summarize } from './summary'
import type { Decision, UndoState } from './undo'

type SuggestionRow = typeof suggestions.$inferSelect
type QuestionRow = typeof questions.$inferSelect

/** Quick options shown as buttons (the contract allows up to 4). */
export const MAX_OPTIONS = 4

export interface DecideItem {
  id: string
  bulletId: string
  summary: Summary
  tier: SuggestionTier
  isNewTracker: boolean
  /** Set while the "Added / Dismissed · Undo" window is open. */
  decision: Decision | null
  /** Edit-then-accept makes sense (a new thing or a reading; not a change to an existing one). */
  editable: boolean
}

export interface CaptureGroup {
  bulletId: string
  snippet: string
  source: BulletSource
  items: DecideItem[]
  /** Items still waiting (not in an Undo window). */
  pending: DecideItem[]
  hasNewTracker: boolean
}

export interface QuestionItem {
  id: string
  text: string
  options: string[]
  bulletId: string
}

export interface DoneItem {
  suggestionId: string
  summary: Summary
  /** Applied because the user tapped a question's option (rather than automatically). */
  viaQuestion: boolean
  /** True once the server confirmed it (before that it's only on the phone). */
  confirmed: boolean
}

export interface InboxNotice {
  key: string
  text: string
}

export interface InboxView {
  groups: CaptureGroup[]
  /** Suggestions waiting for a decision (matches the corner count's share). */
  pendingCount: number
  questions: QuestionItem[]
  done: DoneItem[]
  notices: InboxNotice[]
  /** Nothing to decide, answer or show. */
  empty: boolean
}

export interface InboxRows {
  /** Pending suggestions plus any whose Undo window is open, oldest first. */
  decide: SuggestionRow[]
  /** Accepted/edited suggestions resolved or applied today. */
  appliedToday: SuggestionRow[]
  openQuestions: QuestionRow[]
  /** Suggestion ids that a tapped question option accepted. */
  answeredSuggestionIds: ReadonlySet<string>
  bullets: ReadonlyMap<string, { text: string; source: BulletSource }>
  /** Every suggestion we may need a name for (notices), by id. */
  named: ReadonlyMap<string, SuggestionRow>
  rejections: SyncRejection[]
  ctx: SummaryContext
}

const EDITABLE = new Set(['create', 'append'])

export function buildInbox(rows: InboxRows, undo: UndoState): InboxView {
  const decisions = new Map(undo.map((e) => [e.suggestionId, e.decision]))
  const byBullet = new Map<string, CaptureGroup>()
  for (const s of rows.decide) {
    const decision = decisions.get(s.id) ?? null
    if (s.status !== 'pending' && decision === null) continue
    const item: DecideItem = {
      id: s.id,
      bulletId: s.source_bullet_id,
      summary: summarize(s, rows.ctx),
      tier: s.tier,
      isNewTracker: s.target_kind === 'tracker' && s.operation === 'create',
      decision,
      editable: EDITABLE.has(s.operation),
    }
    let group = byBullet.get(s.source_bullet_id)
    if (!group) {
      const b = rows.bullets.get(s.source_bullet_id)
      group = {
        bulletId: s.source_bullet_id,
        snippet: b ? snippet(b.text) : '',
        source: b?.source ?? 'text',
        items: [],
        pending: [],
        hasNewTracker: false,
      }
      byBullet.set(s.source_bullet_id, group)
    }
    group.items.push(item)
    if (decision === null) group.pending.push(item)
    if (item.isNewTracker && decision === null) group.hasNewTracker = true
  }
  const groups = [...byBullet.values()]

  const questionItems = rows.openQuestions.map((q) => ({
    id: q.id,
    text: q.text,
    options: q.options.slice(0, MAX_OPTIONS),
    bulletId: q.source_bullet_id,
  }))

  const done = rows.appliedToday
    .filter((s) => s.auto_applied || rows.answeredSuggestionIds.has(s.id))
    .map((s) => ({
      suggestionId: s.id,
      summary: summarize(s, rows.ctx),
      viaQuestion: !s.auto_applied,
      confirmed: s.applied_at !== null,
    }))

  const notices = rows.rejections.flatMap((r) => {
    const text = noticeText(r, rows.named, rows.ctx)
    return text ? [{ key: r.key, text }] : []
  })

  const pendingCount = groups.reduce((n, g) => n + g.pending.length, 0)
  return {
    groups,
    pendingCount,
    questions: questionItems,
    done,
    notices,
    empty: groups.length === 0 && questionItems.length === 0 && done.length === 0,
  }
}

/** A calm sentence for a refused decision, or null for refusals the Inbox doesn't explain. */
export function noticeText(
  r: SyncRejection,
  named: ReadonlyMap<string, SuggestionRow>,
  ctx: SummaryContext,
): string | null {
  const s = r.suggestion_id ? named.get(r.suggestion_id) : undefined
  const name = s ? `“${summarize(s, ctx).name}”` : null
  switch (r.type) {
    case 'suggestion.accept':
      return `${name ? `Couldn't add ${name}` : "Couldn't add that"}: things changed since it was suggested, so nothing was changed.`
    case 'suggestion.undo':
      return r.code === 'conflict'
        ? `${name ?? 'That item'} stays as you left it: you changed it after it was added, so Undo won't overwrite your edit.`
        : `${name ? `Couldn't undo ${name}` : "Couldn't undo that"}; it's still there, unchanged.`
    case 'question.answer':
      return 'Your answer arrived after that was already decided, so nothing changed.'
    default:
      return null
  }
}

/** Midnight today in `timezone`. */
export function startOfDay(now: number, timezone: string): number {
  const p = zonedParts(now, timezone)
  return zonedToEpoch({ year: p.year, month: p.month, day: p.day }, timezone)
}

const NOTICE_TYPES = new Set(['suggestion.accept', 'suggestion.undo', 'question.answer'])

/** Fetch what `buildInbox` needs from the local mirror. */
export function loadInboxRows(
  db: PhoneDb,
  opts: { now: number; timezone: string; heldIds: readonly string[] },
): InboxRows {
  const active = eq(suggestions.state, 'active')
  const pending = listPendingSuggestions(db)
  const held =
    opts.heldIds.length === 0
      ? []
      : db
          .select()
          .from(suggestions)
          .where(and(active, inArray(suggestions.id, [...opts.heldIds])))
          .all()
  const pendingIds = new Set(pending.map((s) => s.id))
  const decide = [...pending, ...held.filter((s) => !pendingIds.has(s.id))].sort(
    (a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id),
  )

  const since = startOfDay(opts.now, opts.timezone)
  const appliedToday = db
    .select()
    .from(suggestions)
    .where(and(active, inArray(suggestions.status, ['accepted', 'edited'])))
    .all()
    .filter((s) => (s.applied_at ?? s.resolved_at ?? s.updated_at) >= since)
    .sort((a, b) => (b.applied_at ?? b.resolved_at ?? 0) - (a.applied_at ?? a.resolved_at ?? 0))

  const answeredSuggestionIds = new Set(
    db
      .select({ suggestion_id: questions.suggestion_id, option: questions.answer_option })
      .from(questions)
      .where(and(eq(questions.state, 'active'), eq(questions.status, 'answered')))
      .all()
      .filter((q) => q.option !== null && q.suggestion_id !== null)
      .map((q) => q.suggestion_id as string),
  )

  const openQuestions = listOpenQuestions(db)
  const rejections = listRejections(db).filter((r) => NOTICE_TYPES.has(r.type))

  const shown = [...decide, ...appliedToday]
  const bulletIds = [
    ...new Set([
      ...shown.map((s) => s.source_bullet_id),
      ...openQuestions.map((q) => q.source_bullet_id),
    ]),
  ]
  const bulletMap = new Map(
    (bulletIds.length === 0
      ? []
      : db
          .select({ id: bullets.id, text: bullets.text, source: bullets.source })
          .from(bullets)
          .where(inArray(bullets.id, bulletIds))
          .all()
    ).map((b) => [b.id, { text: b.text, source: b.source }]),
  )

  const named = new Map(shown.map((s) => [s.id, s]))
  const missing = rejections
    .map((r) => r.suggestion_id)
    .filter((id): id is string => !!id && !named.has(id))
  if (missing.length > 0) {
    for (const s of db.select().from(suggestions).where(inArray(suggestions.id, missing)).all()) {
      named.set(s.id, s)
    }
  }

  return {
    decide,
    appliedToday,
    openQuestions,
    answeredSuggestionIds,
    bullets: bulletMap,
    named,
    rejections,
    ctx: summaryContext(db, [...named.values()], opts.now, opts.timezone),
  }
}

/** Tracker names/scales and task/event titles the summaries refer to. */
export function summaryContext(
  db: PhoneDb,
  rows: SuggestionRow[],
  now: number,
  timezone: string,
): SummaryContext {
  const trackerMap = new Map<string, { name: string; config: TrackerConfig }>()
  for (const t of db
    .select({ id: trackers.id, name: trackers.name, config: trackers.config })
    .from(trackers)
    .all()) {
    trackerMap.set(t.id, { name: t.name, config: t.config })
  }
  // A reading may point at a tracker that is itself still a suggestion (its id is the
  // suggestion id once created).
  for (const s of db
    .select()
    .from(suggestions)
    .where(and(eq(suggestions.target_kind, 'tracker'), eq(suggestions.state, 'active')))
    .all()) {
    const p = s.payload
    if (!trackerMap.has(s.id) && typeof p.name === 'string' && p.config) {
      trackerMap.set(s.id, { name: p.name, config: p.config as TrackerConfig })
    }
  }
  const targetIds = rows
    .filter((s) => s.operation === 'update' && s.target_id)
    .map((s) => s.target_id as string)
  const titles = new Map<string, string>()
  if (targetIds.length > 0) {
    for (const table of [tasks, events] as const) {
      const t = table as typeof tasks
      for (const r of db
        .select({ id: t.id, title: t.title })
        .from(t)
        .where(inArray(t.id, targetIds))
        .all()) {
        titles.set(r.id, r.title)
      }
    }
  }
  return { now, timezone, trackers: trackerMap, titles }
}

/** A waiting suggestion for the Edit sheet, with its summary and tracker; null once decided. */
export function loadEditable(db: PhoneDb, suggestionId: string, now: number, timezone: string) {
  const s = db.select().from(suggestions).where(eq(suggestions.id, suggestionId)).get()
  if (!s || s.state !== 'active' || s.status !== 'pending') return null
  const ctx = summaryContext(db, [s], now, timezone)
  const trackerId =
    typeof s.payload.tracker_id === 'string' ? s.payload.tracker_id : (s.target_id ?? '')
  return { s, summary: summarize(s, ctx), tracker: ctx.trackers.get(trackerId) ?? null }
}
