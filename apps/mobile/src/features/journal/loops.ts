/**
 * Journal · open loops: `to_check` and `question` thoughts still open, each with the capture it
 * came from, and the recently closed ones for the collapsed "Done · N" list.
 */

import { type BulletSource, RESOLVABLE_THOUGHT_KINDS } from '@bullet/core'
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import type { PhoneDb } from '../../data/db'
import { bullets, suggestions, thoughts } from '../../data/schema'
import { closedByLine } from '../connections/copy'
import { whenLabel } from './format'

export interface LoopItem {
  id: string
  kind: 'to_check' | 'question'
  text: string
  bulletId: string
  source: BulletSource
  capturedAt: number
  timezone: string
  resolvedAt: number | null
  /** Closed by a capture (a note, or an answer you confirmed), rather than checked off. */
  resolvedByBulletId: string | null
  /** "Closed by «…»" (that capture's words), "Closed with a note", or "Checked off". */
  closedLine?: string
}

export interface Loops {
  toCheck: LoopItem[]
  questions: LoopItem[]
  /** Closed loops, most recently closed first. */
  done: LoopItem[]
}

export const DONE_LOOPS_SHOWN = 50

function select(db: PhoneDb, open: boolean) {
  return db
    .select({
      id: thoughts.id,
      kind: thoughts.kind,
      text: thoughts.text,
      bulletId: thoughts.source_bullet_id,
      resolvedAt: thoughts.resolved_at,
      resolvedByBulletId: thoughts.resolved_by_bullet_id,
      source: bullets.source,
      capturedAt: bullets.captured_at,
      timezone: bullets.timezone,
    })
    .from(thoughts)
    .innerJoin(bullets, eq(bullets.id, thoughts.source_bullet_id))
    .where(
      and(
        eq(thoughts.state, 'active'),
        eq(bullets.state, 'active'),
        inArray(thoughts.kind, [...RESOLVABLE_THOUGHT_KINDS]),
        open ? isNull(thoughts.resolved_at) : isNotNull(thoughts.resolved_at),
      ),
    )
}

export function listLoops(db: PhoneDb): Loops {
  const open = select(db, true).orderBy(desc(bullets.captured_at)).all() as LoopItem[]
  const closed = select(db, false)
    .orderBy(desc(thoughts.resolved_at))
    .limit(DONE_LOOPS_SHOWN)
    .all() as LoopItem[]
  const answers = closingAnswers(
    db,
    closed.filter((l) => l.resolvedByBulletId).map((l) => l.id),
  )
  const done = closed.map((l) => {
    const a = answers.get(l.id)
    return {
      ...l,
      closedLine: closedLine(a && a.bulletId === l.resolvedByBulletId ? a.text : null, l),
    }
  })
  return {
    toCheck: open.filter((l) => l.kind === 'to_check'),
    questions: open.filter((l) => l.kind === 'question'),
    done,
  }
}

/**
 * For loops closed by an accepted "Did this close it?": the answering thought (vetted by the
 * server, never from a capture with a sensitive thought) and its capture. A capture's raw text is
 * never quoted here: it may hold a sensitive thought.
 */
function closingAnswers(
  db: PhoneDb,
  loopIds: readonly string[],
): Map<string, { text: string; bulletId: string }> {
  if (loopIds.length === 0) return new Map()
  const accepted = db
    .select({
      loop: suggestions.target_id,
      thought: suggestions.source_thought_id,
      bullet: suggestions.source_bullet_id,
    })
    .from(suggestions)
    .where(
      and(
        eq(suggestions.state, 'active'),
        eq(suggestions.target_kind, 'thought_resolve'),
        inArray(suggestions.status, ['accepted', 'edited']),
        inArray(suggestions.target_id, [...loopIds]),
      ),
    )
    .all()
  const thoughtIds = accepted.flatMap((s) => (s.thought ? [s.thought] : []))
  if (thoughtIds.length === 0) return new Map()
  const texts = new Map(
    db
      .select({ id: thoughts.id, text: thoughts.text })
      .from(thoughts)
      .where(and(inArray(thoughts.id, thoughtIds), eq(thoughts.state, 'active')))
      .all()
      .map((t) => [t.id, t.text]),
  )
  const out = new Map<string, { text: string; bulletId: string }>()
  for (const s of accepted) {
    const text = s.thought ? texts.get(s.thought) : undefined
    if (s.loop && text) out.set(s.loop, { text, bulletId: s.bullet })
  }
  return out
}

/**
 * How a closed loop was closed: "Closed by «answer»" (an accepted "Did this close it?", quoting
 * only its answering thought), "Closed with a note" (any other capture), or "Checked off".
 */
export function closedLine(
  answerText: string | null | undefined,
  l: Pick<LoopItem, 'resolvedByBulletId'>,
): string {
  if (!l.resolvedByBulletId) return 'Checked off'
  return answerText?.trim() ? closedByLine(answerText) : 'Closed with a note'
}

/** "Voice note · today 08:40" / "Typed · yesterday 19:22" (in the zone it was captured in). */
export function loopSourceLine(l: LoopItem, now: number): string {
  return `${l.source === 'voice' ? 'Voice note' : 'Typed'} · ${whenLabel(l.capturedAt, now, l.timezone)}`
}
