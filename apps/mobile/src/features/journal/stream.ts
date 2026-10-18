/**
 * Journal · stream: capture cards, newest first, grouped by day. Each card has its source (voice
 * with length, or typed), time, state in words and its thoughts. The query is paged by count;
 * the grouping and the state wording are pure.
 */

import {
  type BulletProcessingStatus,
  type BulletSource,
  displayStatus,
  type ProcessingErrorCode,
  type ThoughtKind,
} from '@bullet/core'
import { and, desc, eq, inArray } from 'drizzle-orm'
import type { PhoneDb } from '../../data/db'
import { bulletsWithPendingChanges } from '../../data/mirror'
import { audioAttachments, bullets, suggestions, thoughts } from '../../data/schema'
import { clock, dayKey, dayTitle, duration, spokenDuration } from './format'

export interface CardThought {
  id: string
  kind: ThoughtKind
  text: string
}

export interface CaptureCard {
  id: string
  text: string
  source: BulletSource
  capturedAt: number
  timezone: string
  /** The recording's length (voice notes). */
  durationMs: number | null
  status: BulletProcessingStatus
  errorCode: ProcessingErrorCode | null
  attempts: number
  nextRetryAt: number | null
  thoughts: CardThought[]
  /** Things applied for the user automatically. */
  autoApplied: number
  /** Suggestions waiting for a decision. */
  pending: number
}

export interface StreamPage {
  cards: CaptureCard[]
  /** More captures exist beyond `limit`. */
  hasMore: boolean
}

/** The newest `limit` captures (deleted ones excluded). */
export function listCaptureCards(db: PhoneDb, limit: number): StreamPage {
  const rows = db
    .select()
    .from(bullets)
    .where(eq(bullets.state, 'active'))
    .orderBy(desc(bullets.captured_at))
    .limit(limit + 1)
    .all()
  const page = rows.slice(0, limit)
  const ids = page.map((b) => b.id)
  if (ids.length === 0) return { cards: [], hasMore: false }

  const pending = bulletsWithPendingChanges(db)
  const thoughtsBy = new Map<string, CardThought[]>()
  for (const t of db
    .select()
    .from(thoughts)
    .where(and(inArray(thoughts.source_bullet_id, ids), eq(thoughts.state, 'active')))
    .orderBy(thoughts.position)
    .all()) {
    const list = thoughtsBy.get(t.source_bullet_id) ?? []
    list.push({ id: t.id, kind: t.kind, text: t.text })
    thoughtsBy.set(t.source_bullet_id, list)
  }
  const durationBy = new Map<string, number>()
  for (const a of db
    .select({ bullet_id: audioAttachments.bullet_id, duration_ms: audioAttachments.duration_ms })
    .from(audioAttachments)
    .where(and(inArray(audioAttachments.bullet_id, ids), eq(audioAttachments.state, 'active')))
    .all()) {
    durationBy.set(a.bullet_id, a.duration_ms)
  }
  const counts = new Map<string, { auto: number; pending: number }>()
  for (const s of db
    .select({
      bullet: suggestions.source_bullet_id,
      status: suggestions.status,
      auto: suggestions.auto_applied,
      applied: suggestions.applied_at,
    })
    .from(suggestions)
    .where(and(inArray(suggestions.source_bullet_id, ids), eq(suggestions.state, 'active')))
    .all()) {
    const c = counts.get(s.bullet) ?? { auto: 0, pending: 0 }
    if (s.status === 'pending') c.pending += 1
    else if (s.auto && s.applied !== null && s.status !== 'rejected') c.auto += 1
    counts.set(s.bullet, c)
  }

  const cards = page.map((b) => ({
    id: b.id,
    text: b.text,
    source: b.source,
    capturedAt: b.captured_at,
    timezone: b.timezone,
    durationMs: durationBy.get(b.id) ?? null,
    status: displayStatus(b.server_status, pending.has(b.id)),
    errorCode: b.server_error_code,
    attempts: b.server_attempts,
    nextRetryAt: b.server_next_retry_at,
    thoughts: thoughtsBy.get(b.id) ?? [],
    autoApplied: counts.get(b.id)?.auto ?? 0,
    pending: counts.get(b.id)?.pending ?? 0,
  }))
  return { cards, hasMore: rows.length > limit }
}

// ---- pure ----

export interface DaySection<T> {
  key: string
  title: string
  data: T[]
}

/** Group items (already newest first) into day sections, in the phone's zone. */
export function groupByDay<T>(
  items: readonly T[],
  at: (item: T) => number,
  now: number,
  tz: string,
): DaySection<T>[] {
  const sections: DaySection<T>[] = []
  for (const item of items) {
    const key = dayKey(at(item), tz)
    const last = sections.at(-1)
    if (last?.key === key) last.data.push(item)
    else sections.push({ key, title: dayTitle(at(item), now, tz), data: [item] })
  }
  return sections
}

export type StateTone = 'muted' | 'secondary' | 'warning' | 'accent'

export interface CardState {
  label: string
  tone: StateTone
  /** Show the offline (cloud-slash) icon: the capture has not left this phone. */
  onPhone: boolean
  /** "Not processed": offer Retry, with a calm reason. */
  retry: boolean
  reason: string | null
}

/** Why a capture wasn't processed, in plain words (the capture itself is always safe). */
export function errorReason(code: ProcessingErrorCode | null): string {
  switch (code) {
    case 'llm_unavailable':
      return "Home server's AI didn't respond."
    case 'llm_timeout':
      return "Home server's AI took too long."
    case 'llm_bad_output':
      return "Home server's AI gave an answer it couldn't use."
    case 'transcription_unavailable':
      return "Home server's transcriber didn't respond."
    case 'transcription_timeout':
      return 'Transcribing took too long.'
    case 'transcription_failed':
      return "The recording couldn't be transcribed. It's kept."
    default:
      return 'Something went wrong on the home server.'
  }
}

export function cardState(
  c: Pick<CaptureCard, 'status' | 'errorCode' | 'autoApplied' | 'pending'>,
): CardState {
  const base = { onPhone: false, retry: false, reason: null }
  switch (c.status) {
    case 'saved_local':
      return { ...base, label: 'On this phone', tone: 'secondary', onPhone: true }
    case 'synced':
      return c.errorCode
        ? { ...base, label: 'Retrying…', tone: 'secondary' }
        : { ...base, label: 'Waiting for home', tone: 'muted' }
    case 'transcribing':
      return { ...base, label: 'Transcribing…', tone: 'secondary' }
    case 'processing':
      return { ...base, label: 'Reading…', tone: 'secondary' }
    case 'needs_review':
      return { ...base, label: 'Needs review', tone: 'accent' }
    case 'failed':
      return {
        ...base,
        label: 'Not processed',
        tone: 'warning',
        retry: true,
        reason: errorReason(c.errorCode),
      }
    case 'processed':
      return { ...base, label: c.autoApplied > 0 ? 'Done for you' : 'Done', tone: 'muted' }
  }
}

/** The card's top line: "Voice · 3:12 · 08:40" or "Typed · 07:10". */
export function sourceLine(
  c: Pick<CaptureCard, 'source' | 'durationMs' | 'capturedAt' | 'timezone'>,
): string {
  const time = clock(c.capturedAt, c.timezone)
  if (c.source === 'voice') {
    return c.durationMs !== null ? `Voice · ${duration(c.durationMs)} · ${time}` : `Voice · ${time}`
  }
  return `Typed · ${time}`
}

/** One VoiceOver label for the whole card. */
export function cardAccessibilityLabel(c: CaptureCard): string {
  const state = cardState(c)
  const what =
    c.source === 'voice'
      ? `Voice note${c.durationMs !== null ? `, ${spokenDuration(c.durationMs)}` : ''}`
      : 'Typed note'
  const thoughtsText =
    c.thoughts.length > 0
      ? c.thoughts.map((t) => `${t.kind.replace('_', ' ')}: ${t.text}`).join('. ')
      : c.text
  return [
    what,
    clock(c.capturedAt, c.timezone),
    state.label.replace(/…$/, ''),
    state.reason,
    thoughtsText,
  ]
    .filter(Boolean)
    .join('. ')
}
