/**
 * Journal · open loops: `to_check` and `question` thoughts still open, each with the capture it
 * came from, and the recently closed ones for the collapsed "Done · N" list.
 */

import { type BulletSource, RESOLVABLE_THOUGHT_KINDS } from '@bullet/core'
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import type { PhoneDb } from '../../data/db'
import { bullets, thoughts } from '../../data/schema'
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
  /** Closed with a note (a capture), rather than checked off. */
  resolvedByBulletId: string | null
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
  const done = select(db, false)
    .orderBy(desc(thoughts.resolved_at))
    .limit(DONE_LOOPS_SHOWN)
    .all() as LoopItem[]
  return {
    toCheck: open.filter((l) => l.kind === 'to_check'),
    questions: open.filter((l) => l.kind === 'question'),
    done,
  }
}

/** "Voice note · today 08:40" / "Typed · yesterday 19:22" (in the zone it was captured in). */
export function loopSourceLine(l: LoopItem, now: number): string {
  return `${l.source === 'voice' ? 'Voice note' : 'Typed'} · ${whenLabel(l.capturedAt, now, l.timezone)}`
}
