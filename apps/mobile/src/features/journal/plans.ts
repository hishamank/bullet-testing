/**
 * Journal · plans: upcoming events by day, then open tasks by due date (overdue and due today
 * highlighted), then tasks done recently. Plus the edit sheet's choices and checks. Pure, except
 * `loadPlans` (the query).
 */

import { and, eq, gte, inArray, or } from 'drizzle-orm'
import type { PhoneDb } from '../../data/db'
import { events, tasks } from '../../data/schema'
import type { EventManualPatch } from '@bullet/core'
import { addDays, zonedParts, zonedToEpoch } from '@bullet/engine'
import { shiftEnd } from '../inbox/edit'
import { DAY_MS, dayDiff, dayKey, dayTitle, shortDay, startOfDay } from './format'

export interface PlanTask {
  id: string
  title: string
  status: 'todo' | 'in_progress' | 'done' | 'migrated' | 'cancelled'
  due_at: number | null
  updated_at: number
  created_at: number
  source_bullet_id: string | null
}

export interface PlanEvent {
  id: string
  title: string
  starts_at: number
  ends_at: number | null
  all_day: boolean
  source_bullet_id: string | null
}

export const DONE_RECENTLY_MS = 7 * DAY_MS

export function loadPlans(db: PhoneDb, now: number) {
  const since = now - 2 * DAY_MS
  const evs = db
    .select()
    .from(events)
    .where(
      and(eq(events.state, 'active'), or(gte(events.starts_at, since), gte(events.ends_at, since))),
    )
    .all()
  const ts = db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.state, 'active'),
        or(
          inArray(tasks.status, ['todo', 'in_progress']),
          and(eq(tasks.status, 'done'), gte(tasks.updated_at, now - DONE_RECENTLY_MS)),
        ),
      ),
    )
    .all()
  return { events: evs as PlanEvent[], tasks: ts as PlanTask[] }
}

/**
 * One task or event by id, whatever its date or status (a deep link from Capture detail may point
 * at a thing outside the lists' window). Null when unknown or deleted.
 */
export function loadPlanItem(
  db: PhoneDb,
  id: string,
): { kind: 'task'; task: PlanTask } | { kind: 'event'; event: PlanEvent } | null {
  const task = db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, id), eq(tasks.state, 'active')))
    .get()
  if (task) return { kind: 'task', task: task as PlanTask }
  const event = db
    .select()
    .from(events)
    .where(and(eq(events.id, id), eq(events.state, 'active')))
    .get()
  return event ? { kind: 'event', event: event as PlanEvent } : null
}

export type Urgency = 'overdue' | 'today' | null

export interface DueInfo {
  label: string
  urgency: Urgency
}

/** "overdue · Mon 12", "due today", "tomorrow", "Fri", "23 Oct", "no date". */
export function dueInfo(due: number | null, now: number, tz: string): DueInfo {
  if (due === null) return { label: 'no date', urgency: null }
  const diff = dayDiff(due, now, tz)
  if (diff < 0) return { label: `overdue · ${shortDay(due, tz)}`, urgency: 'overdue' }
  if (diff === 0) return { label: 'due today', urgency: 'today' }
  if (diff === 1) return { label: 'tomorrow', urgency: null }
  if (diff < 7) return { label: shortDay(due, tz).split(' ')[0] ?? '', urgency: null }
  return { label: shortDay(due, tz), urgency: null }
}

export interface PlanDay {
  key: string
  title: string
  /** The short form for the list's day column: "Today", "Tomorrow", "Thu 23". */
  short: string
  events: PlanEvent[]
}

export interface Plans {
  upcoming: PlanDay[]
  open: (PlanTask & { due: DueInfo })[]
  doneRecently: PlanTask[]
}

export function buildPlans(input: {
  events: readonly PlanEvent[]
  tasks: readonly PlanTask[]
  now: number
  tz: string
}): Plans {
  const { now, tz } = input
  const today = startOfDay(now, tz)
  // Still coming up, or under way (an event that started earlier and hasn't ended).
  const upcoming = input.events
    .filter((e) => (e.ends_at ?? e.starts_at) >= (e.all_day || e.ends_at === null ? today : now))
    .sort((a, b) => a.starts_at - b.starts_at)
  const days: PlanDay[] = []
  for (const e of upcoming) {
    const at = Math.max(e.starts_at, today)
    const key = dayKey(at, tz)
    const last = days.at(-1)
    if (last?.key === key) last.events.push(e)
    else {
      const diff = dayDiff(at, now, tz)
      const short = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : shortDay(at, tz)
      days.push({ key, title: dayTitle(at, now, tz), short, events: [e] })
    }
  }

  const open = input.tasks
    .filter((t) => t.status === 'todo' || t.status === 'in_progress')
    .sort((a, b) => {
      if (a.due_at !== b.due_at) {
        if (a.due_at === null) return 1
        if (b.due_at === null) return -1
        return a.due_at - b.due_at
      }
      return a.created_at - b.created_at
    })
    .map((t) => ({ ...t, due: dueInfo(t.due_at, now, tz) }))

  const doneRecently = input.tasks
    .filter((t) => t.status === 'done' && t.updated_at >= now - DONE_RECENTLY_MS)
    .sort((a, b) => b.updated_at - a.updated_at)

  return { upcoming: days, open, doneRecently }
}

// ---- the edit sheet ----

export type DayChoice = 'today' | 'tomorrow' | 'next_week' | 'none'

export const DAY_CHOICES: { id: DayChoice; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'tomorrow', label: 'Tomorrow' },
  { id: 'next_week', label: 'Next week' },
  { id: 'none', label: 'No date' },
]

/** Default time of day for a task that had no due date. */
export const DEFAULT_DUE_HOUR = 9

/**
 * Move `at` to another day, keeping its time of day (in `tz`). With no `at`, use 09:00.
 * "Next week" is the same weekday a week from today.
 */
export function moveToDay(
  at: number | null,
  choice: Exclude<DayChoice, 'none'>,
  now: number,
  tz: string,
): number {
  const offset = choice === 'today' ? 0 : choice === 'tomorrow' ? 1 : 7
  const day = addDays(zonedParts(now, tz), offset)
  const time = at !== null ? zonedParts(at, tz) : { hour: DEFAULT_DUE_HOUR, minute: 0 }
  return zonedToEpoch({ ...day, hour: time.hour, minute: time.minute }, tz)
}

/** A trimmed, non-empty title, or null when it can't be saved. */
export function cleanTitle(s: string): string | null {
  const t = s.trim().replace(/\s+/g, ' ')
  return t === '' ? null : t
}

/**
 * Moving an event keeps its length: a new start shifts the end by the same amount.
 * Returns the patch to send (only what changed), or null when nothing changed.
 */
export function eventMovePatch(
  e: Pick<PlanEvent, 'starts_at' | 'ends_at'>,
  startsAt: number,
): { starts_at: number; ends_at?: number } | null {
  if (startsAt === e.starts_at) return null
  const ends = shiftEnd(e.starts_at, e.ends_at, startsAt)
  return ends === null ? { starts_at: startsAt } : { starts_at: startsAt, ends_at: ends }
}

/** The event sheet's times: a new start carries the end along (same length); "No end" is null. */
export interface EventTimes {
  starts_at: number
  ends_at: number | null
}

export function moveEventStart(times: EventTimes, startsAt: number): EventTimes {
  return { starts_at: startsAt, ends_at: shiftEnd(times.starts_at, times.ends_at, startsAt) }
}

/** Default end offered when an event had none: an hour after it starts. */
export const DEFAULT_EVENT_LENGTH_MS = 60 * 60_000

export const END_BEFORE_START = "It can't end before it starts."

/**
 * The `event.update` patch for the sheet's edits (only what changed; null when nothing did), or
 * a sentence when the end is before the start (the server would refuse it).
 */
export function eventEditPatch(
  e: Pick<PlanEvent, 'title' | 'starts_at' | 'ends_at'>,
  next: EventTimes & { title: string },
): { ok: true; patch: EventManualPatch | null } | { ok: false; message: string } {
  if (next.ends_at !== null && next.ends_at < next.starts_at) {
    return { ok: false, message: END_BEFORE_START }
  }
  const patch: EventManualPatch = {
    ...(next.title !== e.title ? { title: next.title } : {}),
    ...(next.starts_at !== e.starts_at ? { starts_at: next.starts_at } : {}),
    ...(next.ends_at !== e.ends_at ? { ends_at: next.ends_at } : {}),
  }
  return { ok: true, patch: Object.keys(patch).length > 0 ? patch : null }
}
