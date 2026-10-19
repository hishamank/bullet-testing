/**
 * Reflective questions on the phone (slice 2): the Inbox's "To think about" and "Answered · N",
 * the "Pick a question" list, and the links between an answer and the capture it is about (the
 * Stream header, Capture detail). Queries over the local mirror plus pure wording.
 *
 * Reflective questions are never counted in the Inbox badge and never notified: nothing here
 * feeds `inboxCount`.
 */

import {
  type BulletSource,
  EVERGREEN_QUESTIONS,
  type EvergreenQuestion,
  type QuestionOrigin,
} from '@bullet/core'
import { mayPickEvergreen } from '@bullet/engine'
import { and, eq, inArray } from 'drizzle-orm'
import type { PhoneDb } from '../../data/db'
import {
  listAnsweredReflective,
  listQuestionsToThinkAbout,
  type ReflectiveQuestionView,
} from '../../data/queries'
import { bullets, questions } from '../../data/schema'
import { fromLabel } from '../capture/pinned'
import { snippet } from '../inbox/summary'

const DAY_MS = 24 * 60 * 60 * 1000

/** What a reflective question's card shows. */
export interface ThinkCard {
  id: string
  text: string
  origin: QuestionOrigin
  /** "From your voice note, today 08:40" / "From an open loop, 7 days ago"; null for evergreen. */
  sourceLine: string | null
  /** The capture it is about, when it is on the phone (null for evergreen). */
  sourceBulletId: string | null
}

export interface AnsweredCard extends ThinkCard {
  /** How many captures answered it. */
  answers: number
}

export interface ThinkView {
  /** "To think about": showing now (open, or back from Later), oldest first. */
  toThink: ThinkCard[]
  /** "Answered · N", most recently answered first. */
  answered: AnsweredCard[]
}

/** Shown when the server refuses a "Pick a question" (the phone's copy of it is removed). */
export const PICK_REFUSED_TEXT = "That question couldn't be added. Your answer is still saved."

/** "today", "yesterday", "3 days ago". */
export function daysAgo(at: number, now: number): string {
  const days = Math.max(0, Math.floor((now - at) / DAY_MS))
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

/** Where a reflective question came from, in words; null for an evergreen question. */
export function questionSourceLine(
  origin: QuestionOrigin,
  source: { source: BulletSource; capturedAt: number; timezone: string } | null,
  now: number,
): string | null {
  if (origin === 'evergreen' || !source) return null
  if (origin === 'open_loop') return `From an open loop, ${daysAgo(source.capturedAt, now)}`
  return fromLabel(source, now)
}

function toCard(v: ReflectiveQuestionView, now: number): ThinkCard {
  const q = v.question
  return {
    id: q.id,
    text: q.text,
    origin: q.origin,
    sourceLine: questionSourceLine(
      q.origin,
      v.source
        ? { source: v.source.source, capturedAt: v.source.captured_at, timezone: v.source.timezone }
        : null,
      now,
    ),
    sourceBulletId: q.origin === 'evergreen' ? null : (v.source?.id ?? null),
  }
}

export function loadThinkView(db: PhoneDb, now: number): ThinkView {
  return {
    toThink: listQuestionsToThinkAbout(db, now).map((v) => toCard(v, now)),
    // A connection question answered with "Same thing" / "Different" alone has nothing to add to.
    answered: listAnsweredReflective(db)
      .items.filter((v) => v.question.answer_option === null || v.answers.length > 0)
      .map((v) => ({
        ...toCard(v, now),
        answers: v.answers.length,
      })),
  }
}

export interface EvergreenChoices {
  choices: EvergreenQuestion[]
  /** False when enough reflective questions are open already (a pick would be refused). */
  canPick: boolean
}

/**
 * The "Pick a question" list: every evergreen question except the ones the user said "Not this
 * one" to (a dismissal that was not a second Later), and the ones already waiting in "To think
 * about".
 */
export function evergreenChoices(db: PhoneDb): EvergreenChoices {
  const rows = db
    .select({
      template: questions.template_id,
      status: questions.status,
      snoozes: questions.snooze_count,
    })
    .from(questions)
    .where(
      and(
        eq(questions.state, 'active'),
        eq(questions.kind, 'reflective'),
        eq(questions.origin, 'evergreen'),
      ),
    )
    .all()
  const hidden = new Set(
    rows
      .filter(
        (r) =>
          (r.status === 'dismissed' && r.snoozes < 2) ||
          r.status === 'open' ||
          r.status === 'snoozed',
      )
      .map((r) => r.template),
  )
  const live = db
    .select({ id: questions.id })
    .from(questions)
    .where(
      and(
        eq(questions.state, 'active'),
        eq(questions.kind, 'reflective'),
        inArray(questions.status, ['open', 'snoozed']),
      ),
    )
    .all().length
  return {
    choices: EVERGREEN_QUESTIONS.filter((q) => !hidden.has(q.id)),
    canPick: mayPickEvergreen(live),
  }
}

// ---- answers ↔ the capture they are about ----

/** The reflective question a capture answers (its Stream header, its detail's pinned card). */
export interface ThinkingAbout {
  questionId: string
  text: string
  /** The capture the question is about, when it is on the phone; null for evergreen. */
  sourceBulletId: string | null
  sourceLine: string | null
  /** "Add more" makes sense (the question wasn't dismissed since). */
  canAddMore: boolean
}

/** For each of `bulletIds` that answers a reflective question: that question. */
export function thinkingAboutFor(
  db: PhoneDb,
  bulletIds: readonly string[],
  now: number,
): Map<string, ThinkingAbout> {
  if (bulletIds.length === 0) return new Map()
  const answers = db
    .select({ id: bullets.id, question: bullets.answers_question_id })
    .from(bullets)
    .where(inArray(bullets.id, [...bulletIds]))
    .all()
    .filter((b): b is { id: string; question: string } => b.question !== null)
  if (answers.length === 0) return new Map()
  const qs = db
    .select()
    .from(questions)
    .where(
      and(
        inArray(
          questions.id,
          answers.map((a) => a.question),
        ),
        eq(questions.kind, 'reflective'),
        eq(questions.state, 'active'),
      ),
    )
    .all()
  const sourceIds = [...new Set(qs.map((q) => q.source_bullet_id).filter((x) => x !== null))]
  const sources = new Map(
    (sourceIds.length === 0
      ? []
      : db
          .select({
            id: bullets.id,
            source: bullets.source,
            capturedAt: bullets.captured_at,
            timezone: bullets.timezone,
          })
          .from(bullets)
          .where(and(inArray(bullets.id, sourceIds), eq(bullets.state, 'active')))
          .all()
    ).map((b) => [b.id, b]),
  )
  const byQuestion = new Map(
    qs.map((q) => {
      const src = q.origin === 'evergreen' ? undefined : sources.get(q.source_bullet_id ?? '')
      const about: ThinkingAbout = {
        questionId: q.id,
        text: q.text,
        sourceBulletId: src?.id ?? null,
        sourceLine: questionSourceLine(q.origin, src ?? null, now),
        canAddMore: q.status !== 'dismissed',
      }
      return [q.id, about]
    }),
  )
  const out = new Map<string, ThinkingAbout>()
  for (const a of answers) {
    const about = byQuestion.get(a.question)
    if (about) out.set(a.id, about)
  }
  return out
}

/** A capture that answered a reflective question about this one ("You thought about this"). */
export interface ThoughtAboutAnswer {
  id: string
  snippet: string
  source: BulletSource
  capturedAt: number
  timezone: string
  questionText: string
}

/** Every capture that answered a reflective question about `bulletId`, oldest first. */
export function answersAbout(db: PhoneDb, bulletId: string): ThoughtAboutAnswer[] {
  const qs = db
    .select({ id: questions.id, text: questions.text })
    .from(questions)
    .where(
      and(
        eq(questions.source_bullet_id, bulletId),
        eq(questions.kind, 'reflective'),
        eq(questions.state, 'active'),
      ),
    )
    .all()
  if (qs.length === 0) return []
  const text = new Map(qs.map((q) => [q.id, q.text]))
  return db
    .select()
    .from(bullets)
    .where(
      and(
        eq(bullets.state, 'active'),
        inArray(
          bullets.answers_question_id,
          qs.map((q) => q.id),
        ),
      ),
    )
    .orderBy(bullets.captured_at)
    .all()
    .map((b) => ({
      id: b.id,
      snippet: snippet(b.text),
      source: b.source,
      capturedAt: b.captured_at,
      timezone: b.timezone,
      questionText: text.get(b.answers_question_id ?? '') ?? '',
    }))
}

/** VoiceOver label for an answer's header: "Thinking about: «…»". */
export function thinkingAboutLabel(text: string): string {
  return `Thinking about: «${text}»`
}
