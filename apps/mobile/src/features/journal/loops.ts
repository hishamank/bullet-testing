/**
 * Journal · open loops: `to_check` and `question` thoughts still open, each with the capture it
 * came from, and the recently closed ones for the collapsed "Done · N" list.
 */

import { type BulletSource, RESOLVABLE_THOUGHT_KINDS } from '@bullet/core'
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import type { PhoneDb } from '../../data/db'
import { bullets, thoughts } from '../../data/schema'
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
  const byIds = [...new Set(closed.flatMap((l) => l.resolvedByBulletId ?? []))]
  const closers = new Map(
    (byIds.length === 0
      ? []
      : db
          .select({ id: bullets.id, text: bullets.text })
          .from(bullets)
          .where(and(inArray(bullets.id, byIds), eq(bullets.state, 'active')))
          .all()
    ).map((b) => [b.id, b.text]),
  )
  const done = closed.map((l) => ({
    ...l,
    closedLine: closedLine(l.resolvedByBulletId ? closers.get(l.resolvedByBulletId) : null, l),
  }))
  return {
    toCheck: open.filter((l) => l.kind === 'to_check'),
    questions: open.filter((l) => l.kind === 'question'),
    done,
  }
}

/** How a closed loop was closed: by a capture (quoted), or checked off. */
export function closedLine(
  closerText: string | null | undefined,
  l: Pick<LoopItem, 'resolvedByBulletId'>,
): string {
  if (!l.resolvedByBulletId) return 'Checked off'
  return closerText?.trim() ? closedByLine(closerText) : 'Closed with a note'
}

/** "Voice note · today 08:40" / "Typed · yesterday 19:22" (in the zone it was captured in). */
export function loopSourceLine(l: LoopItem, now: number): string {
  return `${l.source === 'voice' ? 'Voice note' : 'Typed'} · ${whenLabel(l.capturedAt, now, l.timezone)}`
}
