/**
 * Journal · stream: capture cards, newest first, grouped by day. Each card has its source (voice
 * with length, or typed), time, state in words and its thoughts. The query is paged by count;
 * the grouping and the state wording are pure.
 */

import {
  type BulletProcessingStatus,
  type BulletSource,
  displayStatus,
  isPermanentTranscriptionError,
  type ProcessingErrorCode,
  type ThoughtKind,
} from '@bullet/core'
import { and, desc, eq, inArray } from 'drizzle-orm'
import type { PhoneDb } from '../../data/db'
import { bulletsWithPendingChanges } from '../../data/mirror'
import { audioAttachments, bullets, suggestions, syncState, thoughts } from '../../data/schema'
import { audioReadErrorKey } from '../../sync/client'
import { thinkingAboutFor, thinkingAboutLabel } from '../reflect/model'
import { keptAsAudio } from './audio-only'
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
  /** This phone couldn't read its recording file to upload it (the text is kept). */
  audioReadError: boolean
  /** "Keep as audio" was chosen after the recording couldn't be transcribed (phone-local). */
  keptAsAudio: boolean
  status: BulletProcessingStatus
  errorCode: ProcessingErrorCode | null
  attempts: number
  nextRetryAt: number | null
  thoughts: CardThought[]
  /** Things applied for the user automatically. */
  autoApplied: number
  /** Suggestions waiting for a decision. */
  pending: number
  /** The reflective question this capture answers ("Thinking about: «…»"), if any. */
  thinkingAbout: { text: string; sourceBulletId: string | null } | null
}

export interface StreamPage {
  cards: CaptureCard[]
  /** More captures exist beyond `limit`. */
  hasMore: boolean
}

/** The newest `limit` captures (deleted ones excluded). */
export function listCaptureCards(db: PhoneDb, limit: number, now = Date.now()): StreamPage {
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
  const audioBy = new Map<string, string>()
  for (const a of db
    .select({
      id: audioAttachments.id,
      bullet_id: audioAttachments.bullet_id,
      duration_ms: audioAttachments.duration_ms,
    })
    .from(audioAttachments)
    .where(and(inArray(audioAttachments.bullet_id, ids), eq(audioAttachments.state, 'active')))
    .all()) {
    durationBy.set(a.bullet_id, a.duration_ms)
    audioBy.set(a.bullet_id, a.id)
  }
  const unreadable = unreadableRecordings(db, [...audioBy.values()])
  const audioOnly = keptAsAudio(db, ids)
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

  const about = thinkingAboutFor(db, ids, now)

  const cards = page.map((b) => ({
    id: b.id,
    text: b.text,
    source: b.source,
    capturedAt: b.captured_at,
    timezone: b.timezone,
    durationMs: durationBy.get(b.id) ?? null,
    audioReadError: unreadable.has(audioBy.get(b.id) ?? ''),
    keptAsAudio: audioOnly.has(b.id),
    status: displayStatus(b.server_status, pending.has(b.id)),
    errorCode: b.server_error_code,
    attempts: b.server_attempts,
    nextRetryAt: b.server_next_retry_at,
    thoughts: thoughtsBy.get(b.id) ?? [],
    autoApplied: counts.get(b.id)?.auto ?? 0,
    pending: counts.get(b.id)?.pending ?? 0,
    thinkingAbout: (() => {
      const a = about.get(b.id)
      return a ? { text: a.text, sourceBulletId: a.sourceBulletId } : null
    })(),
  }))
  return { cards, hasMore: rows.length > limit }
}

/**
 * Recordings (by attachment id) that this phone couldn't read for upload. The sync client notes
 * why in `sync_state` and clears it ('') once the file uploads.
 */
export function unreadableRecordings(db: PhoneDb, attachmentIds: readonly string[]): Set<string> {
  if (attachmentIds.length === 0) return new Set()
  const byKey = new Map(attachmentIds.map((id) => [audioReadErrorKey(id), id]))
  return new Set(
    db
      .select()
      .from(syncState)
      .where(inArray(syncState.key, [...byKey.keys()]))
      .all()
      .filter((r) => r.value !== '')
      .map((r) => byKey.get(r.key) as string),
  )
}

// ---- pure ----

/** Shown on the card and in detail when this phone couldn't read the recording. No Retry. */
export const AUDIO_READ_ERROR_TEXT =
  "The recording couldn't be read on this phone. The text is kept."

export interface DaySection<T> {
  key: string
  title: string
  data: T[]
}

/**
 * Group items (already newest first) into day sections. Each item's day is read in its own zone
 * (`zoneOf`): the journal is a record of where you were, so a capture made at 23:00 in Beirut
 * stays on that evening even when the phone is now in Paris. Sections keep first-seen order; an
 * item whose day already has a section joins it.
 */
export function groupByDay<T>(
  items: readonly T[],
  at: (item: T) => number,
  now: number,
  zoneOf: (item: T) => string,
): DaySection<T>[] {
  const sections: DaySection<T>[] = []
  const byKey = new Map<string, DaySection<T>>()
  for (const item of items) {
    const tz = zoneOf(item)
    const key = dayKey(at(item), tz)
    const existing = byKey.get(key)
    if (existing) {
      existing.data.push(item)
      continue
    }
    const section = { key, title: dayTitle(at(item), now, tz), data: [item] }
    byKey.set(key, section)
    sections.push(section)
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
  /** The recording can't be transcribed (for good): offer "Write it down" / "Keep as audio". */
  untranscribable: boolean
  reason: string | null
}

/**
 * How a recording that can't be transcribed is worded: no speech heard in it, or audio that
 * couldn't be read at all. Either way the recording is kept and the user picks what to do.
 */
export function untranscribableCopy(code: ProcessingErrorCode | null): {
  title: string
  detail: string
} {
  return code === 'transcription_no_speech'
    ? {
        title: 'No speech found in this recording',
        detail: 'The recording is kept. Write down what you said, or keep it as audio.',
      }
    : {
        title: "Couldn't transcribe this recording",
        detail: "The audio couldn't be read. The recording is kept.",
      }
}

export type TranscriptionFailure = 'ask' | 'kept' | null

/**
 * A capture whose recording can't be transcribed (damaged audio, no speech) is not retried: the
 * user writes it down or keeps it as audio (`kept`). Transient transcriber errors keep Retry.
 */
export function transcriptionFailure(
  status: BulletProcessingStatus,
  errorCode: ProcessingErrorCode | null,
  kept: boolean,
): TranscriptionFailure {
  if (status !== 'failed' || !isPermanentTranscriptionError(errorCode)) return null
  return kept ? 'kept' : 'ask'
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
    case 'transcription_no_speech':
      return "No speech was found in the recording. It's kept."
    default:
      return 'Something went wrong on the home server.'
  }
}

export function cardState(
  c: Pick<CaptureCard, 'status' | 'errorCode' | 'autoApplied' | 'pending'> &
    Partial<Pick<CaptureCard, 'keptAsAudio'>>,
): CardState {
  const base = { onPhone: false, retry: false, untranscribable: false, reason: null }
  switch (transcriptionFailure(c.status, c.errorCode, c.keptAsAudio ?? false)) {
    case 'kept':
      return { ...base, label: 'Audio only', tone: 'muted' }
    case 'ask': {
      const copy = untranscribableCopy(c.errorCode)
      return {
        ...base,
        label: copy.title,
        tone: 'warning',
        untranscribable: true,
        reason: copy.detail,
      }
    }
  }
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
    c.thinkingAbout ? thinkingAboutLabel(c.thinkingAbout.text) : null,
    what,
    clock(c.capturedAt, c.timezone),
    state.label.replace(/…$/, ''),
    state.reason,
    c.audioReadError ? AUDIO_READ_ERROR_TEXT : null,
    thoughtsText,
  ]
    .filter(Boolean)
    .join('. ')
}
