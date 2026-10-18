/**
 * Answer: the capture page with a clarifying question, or an open loop (a to-check or
 * self-question thought), pinned on top. Pure query + formatting.
 */

import type { BulletSource } from '@bullet/core'
import { and, eq } from 'drizzle-orm'
import type { PhoneDb } from '../../data/db'
import { bullets, questions, thoughts } from '../../data/schema'

export interface Pinned {
  kind: 'question' | 'loop'
  id: string
  text: string
  /** The capture it came from. */
  source: { source: BulletSource; capturedAt: number; timezone: string } | null
}

export function findPinned(
  db: PhoneDb,
  target: { question?: string; thought?: string },
): Pinned | null {
  const sourceOf = (bulletId: string) => {
    const b = db
      .select({
        source: bullets.source,
        capturedAt: bullets.captured_at,
        timezone: bullets.timezone,
      })
      .from(bullets)
      .where(eq(bullets.id, bulletId))
      .get()
    return b ?? null
  }
  if (target.question) {
    const q = db
      .select()
      .from(questions)
      .where(and(eq(questions.id, target.question), eq(questions.state, 'active')))
      .get()
    if (q?.status !== 'open') return null
    return { kind: 'question', id: q.id, text: q.text, source: sourceOf(q.source_bullet_id) }
  }
  if (target.thought) {
    const th = db
      .select()
      .from(thoughts)
      .where(and(eq(thoughts.id, target.thought), eq(thoughts.state, 'active')))
      .get()
    if (!th) return null
    return { kind: 'loop', id: th.id, text: th.text, source: sourceOf(th.source_bullet_id) }
  }
  return null
}

function dayKey(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short' }).format(at)
}

/** "From your voice note, today 08:40" — in the zone the capture was made in. */
export function fromLabel(source: NonNullable<Pinned['source']>, now: number): string {
  const what = source.source === 'voice' ? 'your voice note' : 'your note'
  const tz = source.timezone
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
  }).format(source.capturedAt)
  const day = dayKey(source.capturedAt, tz)
  let when: string
  if (day === dayKey(now, tz)) when = 'today'
  else if (day === dayKey(now - 86_400_000, tz)) when = 'yesterday'
  else {
    when = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      day: 'numeric',
      month: 'short',
    }).format(source.capturedAt)
  }
  return `From ${what}, ${when} ${time}`
}
