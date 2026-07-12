/**
 * Trackers-page view-model — pure presentation logic for the tracker grid, the per-input_type
 * detail visualizations, the log dialog, and the create/edit form.
 *
 * Like the other view-models, this shapes already-validated, read-only data (plus small form
 * drafts). The heavy aggregation (daily buckets, year-in-pixels, streaks, correlations) lives in
 * `@bullet/db` and arrives here already rolled-up via the `trackerAnalytics` procedures — this file
 * only lays that data into points, grids, and chips. Every function is pure and unit-tested; the
 * components stay declarative.
 *
 * `config` is a discriminated union on `input_type` — every branch narrows on the discriminant
 * (never a cast, never `any`), so an added input type surfaces as a type error here.
 */

import { dayKey, daysAgo, formatTime, shortDay } from '@/lib/format'
import type {
  BooleanStreaks,
  DailyBucket,
  Tracker,
  TrackerConfig,
  TrackerEntry,
  TrackerInputType,
  YearInPixels,
} from '@/lib/types'

// --- input-type metadata --------------------------------------------------------------------

/** The visualization family a tracker's detail + card use. */
export type VizKind = 'line' | 'heat' | 'select' | 'text'

export interface InputTypeMeta {
  value: TrackerInputType
  label: string
  hint: string
  glyph: string
  viz: VizKind
  /** Whether this type takes a bounded numeric config (scale) — drives the form. */
}

export const INPUT_TYPE_META: Record<TrackerInputType, InputTypeMeta> = {
  scale: {
    value: 'scale',
    label: 'Scale',
    hint: 'A rating between two ends',
    glyph: '/',
    viz: 'line',
  },
  number: {
    value: 'number',
    label: 'Number',
    hint: 'A count or measurement',
    glyph: '#',
    viz: 'line',
  },
  boolean: {
    value: 'boolean',
    label: 'Yes / no',
    hint: "Did it, or didn't",
    glyph: '✓',
    viz: 'heat',
  },
  single_select: {
    value: 'single_select',
    label: 'Single choice',
    hint: 'One of a fixed set',
    glyph: '◉',
    viz: 'select',
  },
  multi_select: {
    value: 'multi_select',
    label: 'Multi choice',
    hint: 'Any of a fixed set',
    glyph: '☰',
    viz: 'select',
  },
  text: { value: 'text', label: 'Text', hint: 'A free-text note', glyph: '"', viz: 'text' },
}

/** The order the form lists input types in. */
export const INPUT_TYPE_ORDER: TrackerInputType[] = [
  'scale',
  'number',
  'boolean',
  'single_select',
  'multi_select',
  'text',
]

export const isNumericType = (t: TrackerInputType): boolean => t === 'scale' || t === 'number'
export const isSelectType = (t: TrackerInputType): boolean =>
  t === 'single_select' || t === 'multi_select'

/** The tracker's unit label, when it is a number tracker with one configured (else ""). */
export function trackerUnit(tracker: Tracker): string {
  return tracker.config.input_type === 'number' ? (tracker.config.unit ?? '') : ''
}

/** The tracker's scale bounds, when it is a scale tracker (else null). */
export function trackerScale(
  tracker: Tracker,
): { min: number; max: number; labels?: string[] } | null {
  return tracker.config.input_type === 'scale'
    ? { min: tracker.config.min, max: tracker.config.max, labels: tracker.config.labels }
    : null
}

/** The configured options, when it is a select tracker (else []). */
export function trackerOptions(tracker: Tracker): string[] {
  return tracker.config.input_type === 'single_select' ||
    tracker.config.input_type === 'multi_select'
    ? tracker.config.options
    : []
}

// --- value formatting -----------------------------------------------------------------------

const asFiniteNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

/** A tracker entry's value as a display string, respecting the tracker's type. */
export function displayValue(value: TrackerEntry['value'], tracker: Tracker): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'number') {
    const unit = trackerUnit(tracker)
    const n = round1(value)
    return unit ? `${n} ${unit}` : n
  }
  return String(value)
}

const round1 = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1))
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

// --- sorting / recency ----------------------------------------------------------------------

/** Entries newest → oldest by logged time. */
export function entriesNewestFirst(entries: TrackerEntry[]): TrackerEntry[] {
  return [...entries].sort((a, b) => b.logged_at - a.logged_at)
}

/** Entries oldest → newest by logged time. */
export function entriesOldestFirst(entries: TrackerEntry[]): TrackerEntry[] {
  return [...entries].sort((a, b) => a.logged_at - b.logged_at)
}

/** A relative "when" label for the last entry ("today" / "Tuesday" / "—"). */
export function lastWhenLabel(entries: TrackerEntry[], now: number = Date.now()): string {
  const latest = latestEntry(entries)
  if (!latest) return ''
  const d = daysAgo(latest.logged_at, now)
  if (d === 0) return 'today'
  if (d === 1) return 'yesterday'
  return shortDay(latest.logged_at, now)
}

export function latestEntry(entries: TrackerEntry[]): TrackerEntry | undefined {
  return entriesNewestFirst(entries)[0]
}

/** How many entries were logged today (local day). */
export function loggedTodayCount(entries: TrackerEntry[], now: number = Date.now()): number {
  const key = dayKey(now)
  return entries.filter((e) => dayKey(e.logged_at) === key).length
}

// --- the tracker grid card ------------------------------------------------------------------

const SPARK_W = 240
const SPARK_H = 44

export interface SparkPoint {
  x: number
  y: number
}

export interface HeatCell {
  on: boolean
  key: string
}

export interface TrackerCardVM {
  id: string
  name: string
  glyph: string
  typeLabel: string
  viz: VizKind
  /** For `line`: a polyline `points` string over a 240×44 viewBox. */
  sparkPoints: string
  /** For `heat`: last ~21 on/off day cells. */
  heat: HeatCell[]
  /** For `select`/`text`: nothing extra — the value line carries it. */
  lastLabel: string
  lastWhen: string
  todayNote: string
  logCta: string
  entryCount: number
  hasData: boolean
}

/**
 * Shape one grid card from a tracker + its entries. The mini-viz is a light read of the raw
 * entries (last-N) — cheap presentation shaping, not the canonical roll-up the detail view pulls
 * from `trackerAnalytics`.
 */
export function trackerCardVM(
  tracker: Tracker,
  entries: TrackerEntry[],
  now: number = Date.now(),
): TrackerCardVM {
  const meta = INPUT_TYPE_META[tracker.input_type]
  const ordered = entriesOldestFirst(entries)
  const latest = ordered[ordered.length - 1]
  const todayN = loggedTodayCount(entries, now)

  let sparkPoints = ''
  let heat: HeatCell[] = []
  if (meta.viz === 'line') {
    const nums = ordered
      .map((e) => asFiniteNumber(e.value))
      .filter((v): v is number => v !== null)
      .slice(-24)
    sparkPoints = sparkline(nums)
  } else if (meta.viz === 'heat') {
    heat = booleanMiniHeat(ordered, now)
  }

  const lastLabel = latest ? cardValueLabel(latest.value) : '—'
  const todayNote =
    entries.length === 0
      ? 'no entries yet'
      : todayN > 0
        ? `${todayN} logged today`
        : `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`

  return {
    id: tracker.id,
    name: tracker.name,
    glyph: meta.glyph,
    typeLabel: meta.label,
    viz: meta.viz,
    sparkPoints,
    heat,
    lastLabel,
    lastWhen: lastWhenLabel(entries, now),
    todayNote,
    logCta: logCta(tracker),
    entryCount: entries.length,
    hasData: entries.length > 0,
  }
}

/** A compact value for the card's big number (no unit suffix for text/select — keep it short). */
function cardValueLabel(value: TrackerEntry['value']): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (Array.isArray(value)) return value[0] ?? '—'
  if (typeof value === 'number') return round1(value)
  const s = String(value)
  return s.length > 18 ? `${s.slice(0, 17)}…` : s
}

/** The log button's verb, matched to the type ("Mark done" reads better for a yes/no habit). */
export function logCta(tracker: Tracker): string {
  return tracker.input_type === 'boolean' ? 'Mark done' : 'Log'
}

/** Build a polyline `points` string across the spark viewBox from a numeric series. */
export function sparkline(values: number[], w = SPARK_W, h = SPARK_H): string {
  if (values.length === 0) return ''
  const p = 3
  if (values.length === 1) return `${p},${h / 2} ${w - p},${h / 2}`
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  return values
    .map((v, i) => {
      const x = p + (i / (values.length - 1)) * (w - 2 * p)
      const y = h - p - ((v - min) / range) * (h - 2 * p)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

/** Last ~21 days of a boolean tracker as on/off cells (a day is "on" if any true entry). */
function booleanMiniHeat(orderedEntries: TrackerEntry[], now: number, days = 21): HeatCell[] {
  const onKeys = new Set(
    orderedEntries.filter((e) => e.value === true).map((e) => dayKey(e.logged_at)),
  )
  const cells: HeatCell[] = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const key = dayKey(d.getTime())
    cells.push({ on: onKeys.has(key), key })
  }
  return cells
}

// --- detail: scale / number trend line ------------------------------------------------------

export interface TrendPoint {
  x: number
  y: number
}

export interface TrendViz {
  points: string
  dots: TrendPoint[]
  gridLines: number[]
  recentAvg: string
  priorAvg: string | null
  hasData: boolean
}

const TREND_W = 640
const TREND_H = 120

/**
 * A trend line over a daily-bucketed series (the last `window` days present). Y is scaled to the
 * scale bounds when given, else to the observed range. Also returns the recent vs. prior mean for
 * the "avg X · was Y" caption.
 */
export function trendViz(
  series: DailyBucket[],
  opts: { min?: number; max?: number; window?: number } = {},
): TrendViz {
  const window = opts.window ?? 30
  const recent = series.slice(-window)
  if (recent.length === 0) {
    return {
      points: '',
      dots: [],
      gridLines: gridLines(),
      recentAvg: '—',
      priorAvg: null,
      hasData: false,
    }
  }
  const means = recent.map((b) => b.mean)
  const lo = opts.min ?? Math.min(...means)
  const hi = opts.max ?? Math.max(...means)
  const range = hi - lo || 1
  const p = 6
  const dots: TrendPoint[] = recent.map((b, i) => {
    const x = recent.length === 1 ? TREND_W / 2 : p + (i / (recent.length - 1)) * (TREND_W - 2 * p)
    const y = TREND_H - p - ((b.mean - lo) / range) * (TREND_H - 2 * p)
    return { x: round2(x), y: round2(y) }
  })
  const priorSlice = series.slice(-2 * window, -window).map((b) => b.mean)
  return {
    points: dots.map((d) => `${d.x},${d.y}`).join(' '),
    dots,
    gridLines: gridLines(),
    recentAvg: round1(mean(means)),
    priorAvg: priorSlice.length ? round1(mean(priorSlice)) : null,
    hasData: true,
  }
}

const round2 = (n: number): number => Math.round(n * 100) / 100
function gridLines(): number[] {
  return [0, 0.25, 0.5, 0.75, 1].map((f) => round2(f * TREND_H))
}

/** Total + average for the number-viz caption. */
export function numberSummary(series: DailyBucket[]): {
  avg: string
  total: string
  count: number
} {
  const sums = series.map((b) => b.sum)
  const total = sums.reduce((a, b) => a + b, 0)
  const count = series.reduce((a, b) => a + b.count, 0)
  const allMeans = series.flatMap((b) => Array(b.count).fill(b.mean))
  return { avg: round1(mean(allMeans)), total: round1(total), count }
}

// --- detail: year in pixels (scale) ---------------------------------------------------------

export interface YearCell {
  real: boolean
  bg: string
  title: string
}

export interface YearRow {
  name: string
  cells: YearCell[]
}

export interface YearGrid {
  rows: YearRow[]
  legend: string[]
  hasData: boolean
}

const MONTH_ABBR = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] // Feb padded to 29 (leap-safe grid)

/**
 * Lay a year-in-pixels roll-up into 12 month rows × 31 day cells, colouring each present day by
 * its mean against the scale (or observed) range. Empty days render as blanks.
 */
export function yearGrid(yip: YearInPixels): YearGrid {
  const byKey = new Map<string, (typeof yip.days)[number]>()
  for (const d of yip.days) byKey.set(`${d.month}-${d.dayOfMonth}`, d)

  const lo = yip.scaleMin ?? yip.min
  const hi = yip.scaleMax ?? yip.max
  const rows: YearRow[] = MONTH_ABBR.map((name, month) => {
    const cells: YearCell[] = []
    for (let day = 1; day <= 31; day++) {
      if (day > (DAYS_IN_MONTH[month] ?? 31)) {
        cells.push({ real: false, bg: 'transparent', title: '' })
        continue
      }
      const hit = byKey.get(`${month}-${day}`)
      if (!hit) {
        cells.push({ real: true, bg: 'var(--color-line-soft)', title: `${name} ${day} · no entry` })
      } else {
        cells.push({
          real: true,
          bg: heatColor(hit.mean, lo, hi),
          title: `${name} ${day} · ${round1(hit.mean)}`,
        })
      }
    }
    return { name, cells }
  })
  const legend = [0, 0.25, 0.5, 0.75, 1].map((f) =>
    heatColor(lo === null || hi === null ? f : lo + f * (hi - lo), lo, hi),
  )
  return { rows, legend, hasData: yip.days.length > 0 }
}

/**
 * An ochre wash whose opacity tracks `value` within `[lo, hi]` — low reads pale, high reads deep.
 * Falls back to a mid tint when the range is unknown. Returned as an rgba() string for inline use.
 */
export function heatColor(value: number, lo: number | null, hi: number | null): string {
  if (lo === null || hi === null || hi === lo) return 'rgba(176, 132, 59, 0.55)'
  const t = Math.max(0, Math.min(1, (value - lo) / (hi - lo)))
  const opacity = 0.16 + t * 0.79 // 0.16 → 0.95
  return `rgba(176, 132, 59, ${opacity.toFixed(3)})`
}

// --- detail: boolean streak heatmap ---------------------------------------------------------

export interface HeatmapCell {
  real: boolean
  on: boolean
  title: string
}

export interface HeatmapColumn {
  cells: HeatmapCell[]
}

export interface StreakViz {
  current: number
  longest: number
  /** "X of 30" style rate for the current month. */
  monthOnDays: number
  monthElapsed: number
  columns: HeatmapColumn[]
  dayLabels: string[]
  hasData: boolean
}

const WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

/**
 * A GitHub-style heatmap for a boolean tracker over the last `weeks` weeks, plus the current/longest
 * streaks and this-month completion. Columns are weeks (Sun→Sat rows); off-window cells blank out.
 */
export function streakViz(
  streaks: BooleanStreaks,
  now: number = Date.now(),
  weeks = 26,
): StreakViz {
  const onDayNumbers = new Set(streaks.onDays)
  const todayN = streaks.todayNumber
  // Walk back to the most recent Sunday, then span `weeks` columns forward.
  const todayDate = new Date(now)
  const startBack = (weeks - 1) * 7 + todayDate.getDay()
  const columns: HeatmapColumn[] = []
  for (let w = 0; w < weeks; w++) {
    const cells: HeatmapCell[] = []
    for (let d = 0; d < 7; d++) {
      const offset = startBack - (w * 7 + d)
      const dayNumber = todayN - offset
      const real = offset >= 0 && dayNumber <= todayN
      cells.push({
        real,
        on: real && onDayNumbers.has(dayNumber),
        title: real ? dayTitle(dayNumber) : '',
      })
    }
    columns.push({ cells })
  }

  // This-month completion.
  const first = new Date(todayDate.getFullYear(), todayDate.getMonth(), 1)
  const monthStartN = dayNumberOfLocal(first.getTime())
  let monthOnDays = 0
  for (let dn = monthStartN; dn <= todayN; dn++) if (onDayNumbers.has(dn)) monthOnDays++
  return {
    current: streaks.current,
    longest: streaks.longest,
    monthOnDays,
    monthElapsed: todayN - monthStartN + 1,
    columns,
    dayLabels: WEEKDAY_INITIALS,
    hasData: streaks.onDays.length > 0,
  }
}

const MS_PER_DAY = 86_400_000
/** The local day index for a timestamp (matches the db's tz-shifted bucketing when tz = local). */
function dayNumberOfLocal(ms: number): number {
  return Math.floor((ms - new Date(ms).getTimezoneOffset() * -60_000) / MS_PER_DAY)
}
function dayTitle(dayNumber: number): string {
  const d = new Date(dayNumber * MS_PER_DAY)
  return `${MONTH_ABBR[d.getUTCMonth()]} ${d.getUTCDate()}`
}

// --- detail: select distribution + history list ---------------------------------------------

export interface DistBar {
  label: string
  count: number
  pct: string
}

/** The share each option holds across a select tracker's entries. */
export function selectDistribution(entries: TrackerEntry[], tracker: Tracker): DistBar[] {
  const options = trackerOptions(tracker)
  const counts = new Map<string, number>()
  let total = 0
  for (const e of entries) {
    const picks = Array.isArray(e.value) ? e.value : typeof e.value === 'string' ? [e.value] : []
    for (const p of picks) {
      counts.set(p, (counts.get(p) ?? 0) + 1)
      total++
    }
  }
  const labels = options.length ? options : [...counts.keys()]
  return labels.map((label) => {
    const count = counts.get(label) ?? 0
    return { label, count, pct: total ? `${Math.round((count / total) * 100)}%` : '0%' }
  })
}

export interface HistoryRow {
  id: string
  day: string
  time: string
  value: string
  isText: boolean
  extracted: boolean
  sourceBulletId: string | null
}

/** The reverse-chronological entry history for the select/text detail views. */
export function historyRows(
  entries: TrackerEntry[],
  tracker: Tracker,
  now: number = Date.now(),
): HistoryRow[] {
  return entriesNewestFirst(entries).map((e) => ({
    id: e.id,
    day: shortDay(e.logged_at, now),
    time: formatTime(e.logged_at),
    value: displayValue(e.value, tracker),
    isText: tracker.input_type === 'text',
    extracted: e.source_bullet_id != null,
    sourceBulletId: e.source_bullet_id,
  }))
}

/** A one-line "Today" summary for the detail log bar. */
export function todaySummary(
  entries: TrackerEntry[],
  tracker: Tracker,
  now: number = Date.now(),
): string {
  const key = dayKey(now)
  const todays = entriesNewestFirst(entries).filter((e) => dayKey(e.logged_at) === key)
  if (todays.length === 0) return 'Nothing logged yet today.'
  const first = todays[0]
  if (!first) return 'Nothing logged yet today.'
  if (todays.length === 1) return `Logged ${displayValue(first.value, tracker)} today.`
  return `${todays.length} logged today · latest ${displayValue(first.value, tracker)}.`
}

// --- the log dialog (manual entry) ----------------------------------------------------------

export type LogValue = number | string | boolean | string[]

/** The starting value for a fresh log, matched to the tracker type. */
export function initialLogValue(tracker: Tracker): LogValue {
  switch (tracker.config.input_type) {
    case 'scale':
      return tracker.config.min
    case 'number':
      return tracker.config.min ?? 0
    case 'boolean':
      return true
    case 'single_select':
      return tracker.config.options[0] ?? ''
    case 'multi_select':
      return []
    case 'text':
      return ''
  }
}

/** Whether the current draft value is loggable for this tracker (guards the submit button). */
export function canLogValue(tracker: Tracker, value: LogValue): boolean {
  switch (tracker.input_type) {
    case 'scale':
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'single_select':
      return typeof value === 'string' && value.length > 0
    case 'multi_select':
      return Array.isArray(value) && value.length > 0
    case 'text':
      return typeof value === 'string' && value.trim().length > 0
  }
}

export interface LogEntryPayload {
  tracker_id: string
  value: TrackerEntry['value']
  logged_at: number
}

/** Normalize a log draft into the `trackerEntries.create` payload (text is trimmed). */
export function logEntryPayload(
  tracker: Tracker,
  value: LogValue,
  now: number = Date.now(),
): LogEntryPayload {
  const v = typeof value === 'string' ? value.trim() : value
  return { tracker_id: tracker.id, value: v, logged_at: now }
}

// --- the create / edit form -----------------------------------------------------------------

export interface TrackerFormValues {
  name: string
  input_type: TrackerInputType
  scaleMin: number
  scaleMax: number
  lowLabel: string
  highLabel: string
  unit: string
  options: string[]
}

export const EMPTY_TRACKER_FORM: TrackerFormValues = {
  name: '',
  input_type: 'scale',
  scaleMin: 1,
  scaleMax: 5,
  lowLabel: '',
  highLabel: '',
  unit: '',
  options: ['', ''],
}

/** Pre-fill the form from an existing tracker (edit-in-place). */
export function trackerFormValues(tracker: Tracker): TrackerFormValues {
  const base = { ...EMPTY_TRACKER_FORM, name: tracker.name, input_type: tracker.input_type }
  const cfg = tracker.config
  switch (cfg.input_type) {
    case 'scale':
      return {
        ...base,
        scaleMin: cfg.min,
        scaleMax: cfg.max,
        lowLabel: cfg.labels?.[0] ?? '',
        highLabel: cfg.labels?.[1] ?? '',
      }
    case 'number':
      return { ...base, unit: cfg.unit ?? '' }
    case 'single_select':
    case 'multi_select':
      return { ...base, options: cfg.options.length ? [...cfg.options] : ['', ''] }
    case 'boolean':
    case 'text':
      return base
  }
}

/** A name is the one hard requirement; select types also need at least one non-empty option. */
export function canSubmitTracker(values: TrackerFormValues): boolean {
  if (values.name.trim().length === 0) return false
  if (isSelectType(values.input_type)) return cleanOptions(values.options).length > 0
  if (values.input_type === 'scale') return values.scaleMin < values.scaleMax
  return true
}

const cleanOptions = (options: string[]): string[] =>
  options.map((o) => o.trim()).filter((o) => o.length > 0)

/**
 * Build the discriminated-union `config` for the chosen input type — the branch narrows the return
 * to exactly that member, so a wrong-shaped config can't be built.
 */
export function buildTrackerConfig(values: TrackerFormValues): TrackerConfig {
  switch (values.input_type) {
    case 'scale': {
      const labels =
        values.lowLabel.trim() || values.highLabel.trim()
          ? [values.lowLabel.trim(), values.highLabel.trim()]
          : undefined
      return {
        input_type: 'scale',
        min: values.scaleMin,
        max: values.scaleMax,
        ...(labels ? { labels } : {}),
      }
    }
    case 'number': {
      const unit = values.unit.trim()
      return { input_type: 'number', ...(unit ? { unit } : {}) }
    }
    case 'single_select':
      return { input_type: 'single_select', options: cleanOptions(values.options) }
    case 'multi_select':
      return { input_type: 'multi_select', options: cleanOptions(values.options) }
    case 'boolean':
      return { input_type: 'boolean' }
    case 'text':
      return { input_type: 'text' }
  }
}

export interface TrackerWritePayload {
  name: string
  input_type: TrackerInputType
  config: TrackerConfig
}

/** Normalize a form draft into the create/update payload. */
export function trackerWritePayload(values: TrackerFormValues): TrackerWritePayload {
  return {
    name: values.name.trim(),
    input_type: values.input_type,
    config: buildTrackerConfig(values),
  }
}

// --- index header counts --------------------------------------------------------------------

/** How many distinct trackers logged at least once today (for the header "N logged today"). */
export function trackersLoggedTodayCount(
  entriesByTracker: Map<string, TrackerEntry[]>,
  now: number = Date.now(),
): number {
  let n = 0
  for (const [, entries] of entriesByTracker) if (loggedTodayCount(entries, now) > 0) n++
  return n
}

/** Group active entries under their tracker id. */
export function entriesByTracker(entries: TrackerEntry[]): Map<string, TrackerEntry[]> {
  const m = new Map<string, TrackerEntry[]>()
  for (const e of entries) {
    const arr = m.get(e.tracker_id)
    if (arr) arr.push(e)
    else m.set(e.tracker_id, [e])
  }
  return m
}
