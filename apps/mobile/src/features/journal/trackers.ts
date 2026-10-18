/**
 * Journal · trackers: one row per tracker with its latest reading and a 14-day sparkline (a line
 * for scale/number readings, bars for counts), plus a row per kind of thing done that isn't
 * linked to a tracker. And a tracker's history, where a reading can be fixed. No manual logging:
 * readings come from captures. The query is `loadTrackers`; the rest is pure.
 */

import { entryValueFits, type TrackerConfig, type TrackerEntryValue } from '@bullet/core'
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm'
import type { PhoneDb } from '../../data/db'
import { activities, trackerEntries, trackers } from '../../data/schema'
import { dayDiff, plural, startOfDay, whenLabel } from './format'
import { entryValueText } from './things'

export const SPARK_DAYS = 14

export interface TrackerRowData {
  id: string
  name: string
  config: TrackerConfig
}

export interface EntryData {
  id: string
  tracker_id: string
  value: TrackerEntryValue
  logged_at: number
  source_bullet_id: string | null
  user_edited_at: number | null
}

export interface ActivityData {
  id: string
  name: string
  occurred_at: number
  tracker_id: string | null
  quantity: number | null
  unit: string | null
  source_bullet_id: string | null
}

/** Readings and activities from the sparkline window, plus each tracker's latest reading. */
export function loadTrackers(db: PhoneDb, now: number, tz: string) {
  const since = startOfDay(now, tz, -(SPARK_DAYS - 1))
  const ts = db
    .select({ id: trackers.id, name: trackers.name, config: trackers.config })
    .from(trackers)
    .where(eq(trackers.state, 'active'))
    .orderBy(trackers.name)
    .all()
  const entries = db
    .select()
    .from(trackerEntries)
    .where(and(eq(trackerEntries.state, 'active'), gte(trackerEntries.logged_at, since)))
    .all() as EntryData[]
  const seen = new Set(entries.map((e) => e.tracker_id))
  for (const t of ts) {
    if (seen.has(t.id)) continue
    const latest = db
      .select()
      .from(trackerEntries)
      .where(and(eq(trackerEntries.state, 'active'), eq(trackerEntries.tracker_id, t.id)))
      .orderBy(desc(trackerEntries.logged_at))
      .limit(1)
      .get()
    if (latest) entries.push(latest as EntryData)
  }
  const acts = db
    .select()
    .from(activities)
    .where(and(eq(activities.state, 'active'), gte(activities.occurred_at, since)))
    .all() as ActivityData[]
  return { trackers: ts, entries, activities: acts }
}

/** A tracker's readings (newest first) and the activities logged under it. */
export function loadTrackerHistory(db: PhoneDb, trackerId: string, limit = 200) {
  const tracker = db
    .select({ id: trackers.id, name: trackers.name, config: trackers.config })
    .from(trackers)
    .where(and(eq(trackers.id, trackerId), eq(trackers.state, 'active')))
    .get()
  const entries = db
    .select()
    .from(trackerEntries)
    .where(and(eq(trackerEntries.tracker_id, trackerId), eq(trackerEntries.state, 'active')))
    .orderBy(desc(trackerEntries.logged_at))
    .limit(limit)
    .all() as EntryData[]
  const acts = db
    .select()
    .from(activities)
    .where(and(eq(activities.tracker_id, trackerId), eq(activities.state, 'active')))
    .orderBy(desc(activities.occurred_at))
    .limit(limit)
    .all() as ActivityData[]
  return { tracker: tracker ?? null, entries, activities: acts }
}

/**
 * Unlinked activities with this name (ignoring case and outer spaces, as SQLite's `lower` does:
 * ASCII only), newest first.
 */
export function loadActivityHistory(db: PhoneDb, name: string, limit = 200): ActivityData[] {
  return db
    .select()
    .from(activities)
    .where(
      and(
        eq(activities.state, 'active'),
        isNull(activities.tracker_id),
        sql`lower(trim(${activities.name})) = lower(trim(${name}))`,
      ),
    )
    .orderBy(desc(activities.occurred_at))
    .limit(limit)
    .all() as ActivityData[]
}

// ---- pure ----

export type Spark =
  | { mode: 'line'; values: (number | null)[] }
  | { mode: 'bars'; counts: number[] }
  | { mode: 'none' }

/** Groups activity names like `loadActivityHistory` matches them. */
export const activityKey = (name: string) => name.trim().toLowerCase()

/** Index 0 = 13 days ago … 13 = today; -1 when outside the window. */
function slot(at: number, now: number, tz: string): number {
  const i = SPARK_DAYS - 1 + dayDiff(at, now, tz)
  return i >= 0 && i < SPARK_DAYS ? i : -1
}

/**
 * The 14-day sparkline. Scale/number readings draw a line through each day's mean (gaps stay
 * gaps); anything else draws bars counting readings plus linked activities per day.
 */
export function sparkline(
  config: TrackerConfig,
  entries: readonly Pick<EntryData, 'value' | 'logged_at'>[],
  linkedActivities: readonly Pick<ActivityData, 'occurred_at'>[],
  now: number,
  tz: string,
): Spark {
  const numeric = config.input_type === 'scale' || config.input_type === 'number'
  if (numeric && entries.some((e) => typeof e.value === 'number')) {
    const sums = Array.from({ length: SPARK_DAYS }, () => 0)
    const ns = Array.from({ length: SPARK_DAYS }, () => 0)
    for (const e of entries) {
      const i = slot(e.logged_at, now, tz)
      if (i < 0 || typeof e.value !== 'number') continue
      sums[i] += e.value
      ns[i] += 1
    }
    if (ns.every((n) => n === 0)) return { mode: 'none' }
    return { mode: 'line', values: sums.map((s, i) => (ns[i] ? s / ns[i] : null)) }
  }
  return barsOf(
    [...entries.map((e) => e.logged_at), ...linkedActivities.map((a) => a.occurred_at)],
    now,
    tz,
  )
}

export function barsOf(times: readonly number[], now: number, tz: string): Spark {
  const counts = Array.from({ length: SPARK_DAYS }, () => 0)
  for (const at of times) {
    const i = slot(at, now, tz)
    if (i >= 0) counts[i] += 1
  }
  return counts.some((c) => c > 0) ? { mode: 'bars', counts } : { mode: 'none' }
}

const dayWord = (at: number, now: number, tz: string) => {
  const d = dayDiff(at, now, tz)
  if (d === 0) return 'today'
  if (d === -1) return 'yesterday'
  return whenLabel(at, now, tz).replace(/ \d\d:\d\d$/, '')
}

function inLastWeek(times: readonly number[], now: number, tz: string) {
  return times.filter((at) => {
    const d = dayDiff(at, now, tz)
    return d <= 0 && d > -7
  }).length
}

export interface TrackerRow {
  id: string
  name: string
  /** "3 / 5 · today", "5 km · today · 3 this week", "No readings yet". */
  summary: string
  spark: Spark
  /** What VoiceOver says for the sparkline. */
  sparkLabel: string
  hasReadings: boolean
}

function sparkWords(name: string, spark: Spark): string {
  if (spark.mode === 'none') return `${name}, nothing in the last 14 days`
  if (spark.mode === 'bars') {
    const total = spark.counts.reduce((a, b) => a + b, 0)
    return `${name}, last 14 days, ${plural(total, 'time')}`
  }
  const vs = spark.values.filter((v): v is number => v !== null)
  const lo = Math.min(...vs)
  const hi = Math.max(...vs)
  const range = lo === hi ? `${fmt(lo)}` : `between ${fmt(lo)} and ${fmt(hi)}`
  return `${name}, last 14 days, ${plural(vs.length, 'day')} with readings, ${range}`
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))

export function trackerRows(input: {
  trackers: readonly TrackerRowData[]
  entries: readonly EntryData[]
  activities: readonly ActivityData[]
  now: number
  tz: string
}): TrackerRow[] {
  const { now, tz } = input
  return input.trackers.map((t) => {
    const es = input.entries.filter((e) => e.tracker_id === t.id)
    const acts = input.activities.filter((a) => a.tracker_id === t.id)
    const spark = sparkline(t.config, es, acts, now, tz)
    const latest = es.reduce<EntryData | null>(
      (m, e) => (!m || e.logged_at > m.logged_at ? e : m),
      null,
    )
    const latestAct = acts.reduce<ActivityData | null>(
      (m, a) => (!m || a.occurred_at > m.occurred_at ? a : m),
      null,
    )
    const parts: string[] = []
    if (latest && (!latestAct || latest.logged_at >= latestAct.occurred_at)) {
      parts.push(entryValueText(latest.value, t.config), dayWord(latest.logged_at, now, tz))
    } else if (latestAct) {
      parts.push(activityText(latestAct) ?? latestAct.name, dayWord(latestAct.occurred_at, now, tz))
    }
    if (spark.mode === 'bars') {
      const week = inLastWeek(
        [...es.map((e) => e.logged_at), ...acts.map((a) => a.occurred_at)],
        now,
        tz,
      )
      if (week > 0) parts.push(`${week} this week`)
    }
    return {
      id: t.id,
      name: t.name,
      summary: parts.length > 0 ? parts.join(' · ') : 'No readings yet',
      spark,
      sparkLabel: sparkWords(t.name, spark),
      hasReadings: parts.length > 0,
    }
  })
}

/** "5 km", or null when the activity has no amount. */
export function activityText(a: Pick<ActivityData, 'quantity' | 'unit'>): string | null {
  if (a.quantity === null) return null
  return [fmt(a.quantity), a.unit].filter(Boolean).join(' ')
}

export interface ActivityRow {
  key: string
  name: string
  summary: string
  spark: Spark
  sparkLabel: string
}

/** Things done that aren't linked to a tracker, one row per name, most recent first. */
export function activityRows(
  acts: readonly ActivityData[],
  now: number,
  tz: string,
): ActivityRow[] {
  const groups = new Map<string, ActivityData[]>()
  for (const a of acts) {
    if (a.tracker_id !== null) continue
    const k = activityKey(a.name)
    groups.set(k, [...(groups.get(k) ?? []), a])
  }
  return [...groups.entries()]
    .map(([key, list]) => {
      const sorted = [...list].sort((a, b) => b.occurred_at - a.occurred_at)
      const latest = sorted[0] as ActivityData
      const times = list.map((a) => a.occurred_at)
      const spark = barsOf(times, now, tz)
      const week = inLastWeek(times, now, tz)
      const summary = [
        activityText(latest),
        dayWord(latest.occurred_at, now, tz),
        week > 1 ? `${week} this week` : null,
      ]
        .filter(Boolean)
        .join(' · ')
      return {
        key,
        name: latest.name.trim(),
        summary,
        spark,
        sparkLabel: sparkWords(latest.name, spark),
        at: latest.occurred_at,
      }
    })
    .sort((a, b) => b.at - a.at)
    .map(({ at: _at, ...row }) => row)
}

// ---- fixing a reading ----

export type ValueInput = string | boolean | string[]

export type ParsedValue = { ok: true; value: TrackerEntryValue } | { ok: false; error: string }

/** Turn what the user typed or picked into a value that fits the tracker, or say why not. */
export function parseEntryValue(input: ValueInput, config: TrackerConfig): ParsedValue {
  const fail = (error: string): ParsedValue => ({ ok: false, error })
  let value: TrackerEntryValue
  switch (config.input_type) {
    case 'scale':
    case 'number': {
      if (typeof input !== 'string') return fail('Enter a number.')
      const n = Number(input.trim().replace(',', '.'))
      if (input.trim() === '' || !Number.isFinite(n)) return fail('Enter a number.')
      if (config.input_type === 'scale' && !Number.isInteger(n)) {
        return fail(`Use a whole number from ${config.min} to ${config.max}.`)
      }
      value = n
      break
    }
    case 'boolean':
      if (typeof input !== 'boolean') return fail('Choose yes or no.')
      value = input
      break
    case 'single_select':
      if (typeof input !== 'string' || input === '') return fail('Choose one.')
      value = input
      break
    case 'multi_select':
      if (!Array.isArray(input) || input.length === 0) return fail('Choose at least one.')
      value = input
      break
    case 'text': {
      const s = typeof input === 'string' ? input.trim() : ''
      if (s === '') return fail('Write something.')
      value = s
      break
    }
  }
  if (!entryValueFits(value, config)) {
    if (config.input_type === 'scale')
      return fail(`Use a number from ${config.min} to ${config.max}.`)
    if (config.input_type === 'number') {
      const lo = config.min
      const hi = config.max
      if (lo !== undefined && hi !== undefined) return fail(`Use a number from ${lo} to ${hi}.`)
      if (lo !== undefined) return fail(`Use ${lo} or more.`)
      if (hi !== undefined) return fail(`Use ${hi} or less.`)
    }
    return fail("That doesn't fit this tracker.")
  }
  return { ok: true, value }
}

/** The editor's starting input for a reading. */
export function valueToInput(value: TrackerEntryValue): ValueInput {
  return typeof value === 'number' ? String(value) : value
}
