/**
 * Tracker analytics — the aggregation queries behind the Trackers page visualizations.
 *
 * These are the ONLY place tracker-entry aggregation lives (per the architectural rule: no
 * aggregation logic in tRPC procedures or React components). Every function reads ACTIVE rows
 * (soft-delete respected) and buckets/rolls-up in plain TypeScript so the math stays
 * **Postgres-portable** — no SQLite-only date functions. Day bucketing is pure epoch arithmetic
 * shifted by an explicit `tzOffsetMinutes` (the caller passes its local offset), so "which day did
 * this fall on" is deterministic and testable rather than dependent on the server's timezone.
 *
 * All timestamps are epoch-ms integers (CLAUDE.md canonical). Numeric aggregations only count
 * entries whose value is a finite number (scale/number trackers); boolean streaks count days with
 * a `true` entry.
 */

import type { Tracker } from '@bullet/core'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../client'
import { activities, trackerEntries, trackers } from '../schema'

const MS_PER_DAY = 86_400_000

/**
 * The day index (days since the Unix epoch) a timestamp falls on, after shifting by the caller's
 * timezone offset. Pure integer arithmetic — no `Date`, Postgres-portable. `tzOffsetMinutes` is the
 * minutes to ADD to UTC to reach local wall-clock (i.e. `-new Date().getTimezoneOffset()`).
 */
export function dayNumberOf(ms: number, tzOffsetMinutes = 0): number {
  return Math.floor((ms + tzOffsetMinutes * 60_000) / MS_PER_DAY)
}

/** "YYYY-MM-DD" for a day index (read via UTC getters — the shift is already baked into the index). */
export function dayKeyOfNumber(dayNumber: number): string {
  const d = new Date(dayNumber * MS_PER_DAY)
  const p = (n: number) => (n < 10 ? `0${n}` : String(n))
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Read the active entries logged against one tracker, oldest → newest. */
function activeEntries(db: Db, trackerId: string) {
  return db
    .select()
    .from(trackerEntries)
    .where(and(eq(trackerEntries.tracker_id, trackerId), eq(trackerEntries.state, 'active')))
    .all()
    .sort((a, b) => a.logged_at - b.logged_at)
}

/** Look one tracker up by id, respecting soft-delete (a deleted tracker reads as absent). */
function activeTracker(db: Db, trackerId: string): Tracker | undefined {
  return db
    .select()
    .from(trackers)
    .where(and(eq(trackers.id, trackerId), eq(trackers.state, 'active')))
    .get()
}

// --- daily-bucketed numeric series -----------------------------------------------------------

/** One calendar day's roll-up of a numeric tracker's entries. */
export interface DailyBucket {
  dayNumber: number
  dayKey: string
  count: number
  sum: number
  mean: number
  min: number
  max: number
  /** The most recently logged value that day (by `logged_at`). */
  last: number
}

export interface DailySeriesOptions {
  tzOffsetMinutes?: number
}

/**
 * Bucket a numeric tracker's entries by calendar day, returning one row per day that has data,
 * oldest → newest. Non-numeric values are ignored (so it is safe to call on any tracker; a
 * text/select tracker simply yields `[]`).
 */
export function trackerDailySeries(
  db: Db,
  trackerId: string,
  opts: DailySeriesOptions = {},
): DailyBucket[] {
  const tz = opts.tzOffsetMinutes ?? 0
  const byDay = new Map<number, { values: number[]; last: number; lastAt: number }>()
  for (const e of activeEntries(db, trackerId)) {
    if (!isFiniteNumber(e.value)) continue
    const dn = dayNumberOf(e.logged_at, tz)
    const bucket = byDay.get(dn)
    if (bucket) {
      bucket.values.push(e.value)
      if (e.logged_at >= bucket.lastAt) {
        bucket.last = e.value
        bucket.lastAt = e.logged_at
      }
    } else {
      byDay.set(dn, { values: [e.value], last: e.value, lastAt: e.logged_at })
    }
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([dayNumber, b]) => {
      const sum = b.values.reduce((acc, v) => acc + v, 0)
      return {
        dayNumber,
        dayKey: dayKeyOfNumber(dayNumber),
        count: b.values.length,
        sum,
        mean: sum / b.values.length,
        min: Math.min(...b.values),
        max: Math.max(...b.values),
        last: b.last,
      }
    })
}

// --- year in pixels (scale trackers) ---------------------------------------------------------

/** One day's cell in the year-in-pixels grid. */
export interface YearDay {
  dayNumber: number
  dayKey: string
  /** 0–11. */
  month: number
  /** 1–31. */
  dayOfMonth: number
  mean: number
  count: number
}

export interface YearInPixels {
  year: number
  /** Observed value range across the year (null when no data). */
  min: number | null
  max: number | null
  /** The tracker's configured scale bounds, when it is a scale tracker (else null). */
  scaleMin: number | null
  scaleMax: number | null
  /** Only days that have data, oldest → newest. The view-model lays these into a month grid. */
  days: YearDay[]
}

/**
 * Roll a tracker's numeric entries up to one mean-per-day for a single calendar year — the
 * "year in pixels" grid. Carries the scale bounds (for scale trackers) so the caller can colour
 * cells against the configured range rather than the observed one.
 */
export function trackerYearInPixels(
  db: Db,
  trackerId: string,
  year: number,
  opts: DailySeriesOptions = {},
): YearInPixels {
  const tracker = activeTracker(db, trackerId)
  const scale = scaleBounds(tracker)
  const series = trackerDailySeries(db, trackerId, opts)
  const days: YearDay[] = []
  let min: number | null = null
  let max: number | null = null
  for (const b of series) {
    const d = new Date(b.dayNumber * MS_PER_DAY)
    if (d.getUTCFullYear() !== year) continue
    days.push({
      dayNumber: b.dayNumber,
      dayKey: b.dayKey,
      month: d.getUTCMonth(),
      dayOfMonth: d.getUTCDate(),
      mean: b.mean,
      count: b.count,
    })
    min = min === null ? b.mean : Math.min(min, b.mean)
    max = max === null ? b.mean : Math.max(max, b.mean)
  }
  return { year, min, max, scaleMin: scale?.min ?? null, scaleMax: scale?.max ?? null, days }
}

function scaleBounds(tracker?: Tracker): { min: number; max: number } | null {
  if (!tracker) return null
  // `config` is a discriminated union on `input_type` — narrow on the discriminant (no cast).
  return tracker.config.input_type === 'scale'
    ? { min: tracker.config.min, max: tracker.config.max }
    : null
}

// --- boolean streaks -------------------------------------------------------------------------

export interface BooleanStreaks {
  /** Consecutive on-days ending today (or yesterday, as a one-day grace) — 0 if broken. */
  current: number
  /** The longest consecutive run of on-days ever recorded. */
  longest: number
  /** Sorted, de-duplicated day indices that had a `true` entry. */
  onDays: number[]
  firstDayNumber: number | null
  lastDayNumber: number | null
  /** The day index "today" resolves to (for the caller's heatmap window). */
  todayNumber: number
}

export interface StreaksOptions {
  tzOffsetMinutes?: number
  now?: number
}

/**
 * Current + longest streak for a boolean tracker. A day is "on" if it has at least one `true`
 * entry. The current streak counts consecutive on-days ending today; if today has no entry yet it
 * falls back to a run ending yesterday (a one-day grace so an un-logged today doesn't read as a
 * broken streak), otherwise it is 0.
 */
export function trackerBooleanStreaks(
  db: Db,
  trackerId: string,
  opts: StreaksOptions = {},
): BooleanStreaks {
  const tz = opts.tzOffsetMinutes ?? 0
  const now = opts.now ?? Date.now()
  const todayNumber = dayNumberOf(now, tz)

  const onSet = new Set<number>()
  for (const e of activeEntries(db, trackerId)) {
    if (e.value === true) onSet.add(dayNumberOf(e.logged_at, tz))
  }
  const onDays = [...onSet].sort((a, b) => a - b)

  // Longest run of consecutive day indices.
  let longest = 0
  let run = 0
  let prev: number | null = null
  for (const dn of onDays) {
    run = prev !== null && dn === prev + 1 ? run + 1 : 1
    if (run > longest) longest = run
    prev = dn
  }

  // Current streak: anchor on today, else yesterday (grace), then walk back while consecutive.
  let current = 0
  const anchor = onSet.has(todayNumber)
    ? todayNumber
    : onSet.has(todayNumber - 1)
      ? todayNumber - 1
      : null
  if (anchor !== null) {
    let cursor = anchor
    while (onSet.has(cursor)) {
      current++
      cursor--
    }
  }

  return {
    current,
    longest,
    onDays,
    firstDayNumber: onDays[0] ?? null,
    lastDayNumber: onDays[onDays.length - 1] ?? null,
    todayNumber,
  }
}

// --- correlations (honest same-day co-occurrence) --------------------------------------------

/**
 * A same-day co-occurrence pattern: a numeric tracker's mean on days a given activity occurred vs.
 * days it did not, within the tracker's observed days. No significance claim — just two honest
 * means over a minimum sample on each side.
 */
export interface Correlation {
  trackerId: string
  trackerName: string
  activityName: string
  withMean: number
  withoutMean: number
  /** `withMean - withoutMean` (positive → higher on activity days). */
  delta: number
  withDays: number
  withoutDays: number
}

export interface CorrelationOptions {
  tzOffsetMinutes?: number
  /** Minimum number of days required on EACH side before a pattern is reported (default 5). */
  minDays?: number
}

const DEFAULT_MIN_DAYS = 5

/** The distinct day indices on which an activity of a given name occurred (case-insensitive). */
function activityDaySet(db: Db, ownerId: string, activityName: string, tz: number): Set<number> {
  const rows = db
    .select()
    .from(activities)
    .where(and(eq(activities.owner_id, ownerId), eq(activities.state, 'active')))
    .all()
  const target = activityName.trim().toLowerCase()
  const days = new Set<number>()
  for (const a of rows) {
    if (a.name.trim().toLowerCase() === target) days.add(dayNumberOf(a.occurred_at, tz))
  }
  return days
}

/**
 * Compute the co-occurrence pattern for one (tracker, activity-name) pair, or `null` when either
 * side has fewer than `minDays` days of data.
 */
export function trackerActivityCorrelation(
  db: Db,
  ownerId: string,
  trackerId: string,
  activityName: string,
  opts: CorrelationOptions = {},
): Correlation | null {
  const tz = opts.tzOffsetMinutes ?? 0
  const minDays = opts.minDays ?? DEFAULT_MIN_DAYS
  const tracker = activeTracker(db, trackerId)
  if (!tracker) return null

  const series = trackerDailySeries(db, trackerId, { tzOffsetMinutes: tz })
  if (series.length === 0) return null
  const activityDays = activityDaySet(db, ownerId, activityName, tz)

  const withVals: number[] = []
  const withoutVals: number[] = []
  for (const day of series) {
    if (activityDays.has(day.dayNumber)) withVals.push(day.mean)
    else withoutVals.push(day.mean)
  }
  if (withVals.length < minDays || withoutVals.length < minDays) return null

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
  const withMean = mean(withVals)
  const withoutMean = mean(withoutVals)
  return {
    trackerId,
    trackerName: tracker.name,
    activityName,
    withMean,
    withoutMean,
    delta: withMean - withoutMean,
    withDays: withVals.length,
    withoutDays: withoutVals.length,
  }
}

/**
 * Scan every active scale/number tracker against every distinct active activity name and return
 * the single strongest qualifying pattern — the "quiet pattern" the Trackers page surfaces — or
 * `null` when nothing clears the `minDays` threshold on both sides. Deterministic: ties on
 * magnitude break toward the larger minimum sample, then the tracker/activity names.
 */
export function findQuietPattern(
  db: Db,
  ownerId: string,
  opts: CorrelationOptions = {},
): Correlation | null {
  const numericTrackers = db
    .select()
    .from(trackers)
    .where(and(eq(trackers.owner_id, ownerId), eq(trackers.state, 'active')))
    .all()
    .filter((t) => t.input_type === 'scale' || t.input_type === 'number')

  const activityNames = distinctActivityNames(db, ownerId)

  let best: Correlation | null = null
  for (const tracker of numericTrackers) {
    for (const name of activityNames) {
      const c = trackerActivityCorrelation(db, ownerId, tracker.id, name, opts)
      if (c && isStrongerPattern(c, best)) best = c
    }
  }
  return best
}

/** Distinct activity display names for an owner (first-seen casing preserved), sorted. */
function distinctActivityNames(db: Db, ownerId: string): string[] {
  const rows = db
    .select()
    .from(activities)
    .where(and(eq(activities.owner_id, ownerId), eq(activities.state, 'active')))
    .all()
  const seen = new Map<string, string>()
  for (const a of rows) {
    const key = a.name.trim().toLowerCase()
    if (key && !seen.has(key)) seen.set(key, a.name.trim())
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b))
}

/** Prefer the larger |delta|; tie-break toward the larger minimum sample, then names. */
function isStrongerPattern(c: Correlation, best: Correlation | null): boolean {
  if (!best) return true
  const cMag = Math.abs(c.delta)
  const bMag = Math.abs(best.delta)
  if (cMag !== bMag) return cMag > bMag
  const cSample = Math.min(c.withDays, c.withoutDays)
  const bSample = Math.min(best.withDays, best.withoutDays)
  if (cSample !== bSample) return cSample > bSample
  return (
    `${c.trackerName}${c.activityName}`.localeCompare(`${best.trackerName}${best.activityName}`) < 0
  )
}
