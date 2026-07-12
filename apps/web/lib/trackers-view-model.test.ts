/**
 * Unit tests for the Trackers-page view-model — the tracker grid card, the per-input_type detail
 * visualizations (trend / year grid / streak heatmap / select distribution / history), the log
 * dialog value model, and the create/edit form's config-union builder.
 *
 * Pure functions over `@/lib/types` fixtures; no server, no DB. The heavy aggregations arrive
 * pre-rolled from `trackerAnalytics`, so here we feed those shapes directly and lock the layout.
 */

import { describe, expect, test } from 'vitest'
import {
  buildTrackerConfig,
  canLogValue,
  canSubmitTracker,
  dayNumberOf,
  EMPTY_TRACKER_FORM,
  initialLogValue,
  logEntryPayload,
  numberSummary,
  selectDistribution,
  streakViz,
  trackerCardVM,
  trackerFormValues,
  trackerWritePayload,
  trendViz,
  yearGrid,
} from '@/lib/trackers-view-model'
import type {
  BooleanStreaks,
  DailyBucket,
  Tracker,
  TrackerConfig,
  TrackerEntry,
  YearInPixels,
} from '@/lib/types'

const OWNER = '00000000-0000-4000-8000-00000000aaaa'
const DAY = 86_400_000
const NOW = new Date(2026, 5, 30, 12, 0, 0).getTime() // Tue 30 Jun 2026, noon

function makeTracker(overrides: Partial<Tracker> = {}): Tracker {
  return {
    id: 'tr-1',
    owner_id: OWNER,
    source_bullet_id: null,
    name: 'Mood',
    input_type: 'scale',
    config: { input_type: 'scale', min: 1, max: 5 },
    created_at: 1000,
    updated_at: 1000,
    state: 'active',
    ...overrides,
  }
}

function makeEntry(overrides: Partial<TrackerEntry> = {}): TrackerEntry {
  return {
    id: 'te-1',
    owner_id: OWNER,
    source_bullet_id: null,
    tracker_id: 'tr-1',
    value: 3,
    logged_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    state: 'active',
    ...overrides,
  }
}

// --- the grid card --------------------------------------------------------------------------

describe('trackerCardVM', () => {
  test('scale tracker → line viz, latest value, today note', () => {
    const t = makeTracker()
    const entries = [
      makeEntry({ id: 'a', value: 2, logged_at: NOW - 2 * DAY }),
      makeEntry({ id: 'b', value: 4, logged_at: NOW }),
    ]
    const vm = trackerCardVM(t, entries, NOW)
    expect(vm.viz).toBe('line')
    expect(vm.sparkPoints.length).toBeGreaterThan(0)
    expect(vm.lastLabel).toBe('4')
    expect(vm.lastWhen).toBe('today')
    expect(vm.todayNote).toBe('1 logged today')
    expect(vm.logCta).toBe('Log')
  })

  test('empty tracker → no data, calm note', () => {
    const vm = trackerCardVM(makeTracker(), [], NOW)
    expect(vm.hasData).toBe(false)
    expect(vm.lastLabel).toBe('—')
    expect(vm.todayNote).toBe('no entries yet')
  })

  test('boolean tracker → heat cells + Mark done CTA', () => {
    const t = makeTracker({ input_type: 'boolean', config: { input_type: 'boolean' } })
    const entries = [makeEntry({ value: true, logged_at: NOW })]
    const vm = trackerCardVM(t, entries, NOW)
    expect(vm.viz).toBe('heat')
    expect(vm.heat.length).toBe(21)
    expect(vm.heat[vm.heat.length - 1]?.on).toBe(true)
    expect(vm.logCta).toBe('Mark done')
  })
})

// --- log dialog -----------------------------------------------------------------------------

describe('log dialog value model', () => {
  test('initialLogValue matches the type', () => {
    expect(initialLogValue(makeTracker())).toBe(1) // scale min
    expect(
      initialLogValue(makeTracker({ input_type: 'boolean', config: { input_type: 'boolean' } })),
    ).toBe(true)
    expect(
      initialLogValue(
        makeTracker({
          input_type: 'single_select',
          config: { input_type: 'single_select', options: ['Low', 'High'] },
        }),
      ),
    ).toBe('Low')
    expect(
      initialLogValue(
        makeTracker({
          input_type: 'multi_select',
          config: { input_type: 'multi_select', options: ['a'] },
        }),
      ),
    ).toEqual([])
  })

  test('canLogValue gates by type', () => {
    const scale = makeTracker()
    expect(canLogValue(scale, 3)).toBe(true)
    expect(canLogValue(scale, 'x')).toBe(false)
    const text = makeTracker({ input_type: 'text', config: { input_type: 'text' } })
    expect(canLogValue(text, '  ')).toBe(false)
    expect(canLogValue(text, 'a note')).toBe(true)
    const multi = makeTracker({
      input_type: 'multi_select',
      config: { input_type: 'multi_select', options: ['a', 'b'] },
    })
    expect(canLogValue(multi, [])).toBe(false)
    expect(canLogValue(multi, ['a'])).toBe(true)
  })

  test('logEntryPayload trims text and stamps logged_at', () => {
    const text = makeTracker({ input_type: 'text', config: { input_type: 'text' } })
    const p = logEntryPayload(text, '  hello  ', NOW)
    expect(p).toEqual({ tracker_id: 'tr-1', value: 'hello', logged_at: NOW })
    const scale = makeTracker()
    expect(logEntryPayload(scale, 4, NOW).value).toBe(4)
  })
})

// --- detail: trend --------------------------------------------------------------------------

describe('trendViz', () => {
  const series: DailyBucket[] = [
    { dayNumber: 1, dayKey: '', count: 1, sum: 2, mean: 2, min: 2, max: 2, last: 2 },
    { dayNumber: 2, dayKey: '', count: 1, sum: 4, mean: 4, min: 4, max: 4, last: 4 },
  ]

  test('scales to given bounds, reports recent avg', () => {
    const v = trendViz(series, { min: 1, max: 5 })
    expect(v.hasData).toBe(true)
    expect(v.dots).toHaveLength(2)
    expect(v.recentAvg).toBe('3')
    expect(v.points.split(' ')).toHaveLength(2)
  })

  test('empty series → no data', () => {
    expect(trendViz([]).hasData).toBe(false)
  })
})

describe('numberSummary', () => {
  test('totals and averages across buckets', () => {
    const series: DailyBucket[] = [
      { dayNumber: 1, dayKey: '', count: 2, sum: 6, mean: 3, min: 2, max: 4, last: 4 },
      { dayNumber: 2, dayKey: '', count: 1, sum: 5, mean: 5, min: 5, max: 5, last: 5 },
    ]
    const s = numberSummary(series)
    expect(s.total).toBe('11')
    expect(s.count).toBe(3)
    expect(s.avg).toBe('3.7') // (3+3+5)/3
  })
})

// --- detail: year in pixels -----------------------------------------------------------------

describe('yearGrid', () => {
  test('lays days into 12 month rows × 31 cells, colours present days', () => {
    const yip: YearInPixels = {
      year: 2026,
      min: 2,
      max: 4,
      scaleMin: 1,
      scaleMax: 5,
      days: [
        { dayNumber: 1, dayKey: '', month: 0, dayOfMonth: 1, mean: 4, count: 1 },
        { dayNumber: 2, dayKey: '', month: 5, dayOfMonth: 15, mean: 2, count: 1 },
      ],
    }
    const g = yearGrid(yip)
    expect(g.rows).toHaveLength(12)
    expect(g.rows[0]?.cells).toHaveLength(31)
    // Jan 1 present + coloured.
    expect(g.rows[0]?.cells[0]?.real).toBe(true)
    expect(g.rows[0]?.cells[0]?.bg).toContain('rgba(176, 132, 59')
    // 2026 is not a leap year: Feb 29/30/31 all blank (no phantom Feb 29 cell).
    expect(g.rows[1]?.cells[28]?.real).toBe(false)
    expect(g.rows[1]?.cells[29]?.real).toBe(false)
    expect(g.rows[1]?.cells[30]?.real).toBe(false)
    // Feb 28 is a real (empty-data) cell.
    expect(g.rows[1]?.cells[27]?.real).toBe(true)
    expect(g.legend).toHaveLength(5)
    expect(g.hasData).toBe(true)
  })

  test('leap year keeps Feb 29 as a real cell', () => {
    const yip: YearInPixels = {
      year: 2028, // leap
      min: null,
      max: null,
      scaleMin: 1,
      scaleMax: 5,
      days: [],
    }
    const g = yearGrid(yip)
    expect(g.rows[1]?.cells[28]?.real).toBe(true) // Feb 29 exists in 2028
    expect(g.rows[1]?.cells[29]?.real).toBe(false)
  })
})

// --- detail: streak heatmap -----------------------------------------------------------------

describe('streakViz', () => {
  // Europe/Athens in summer is UTC+3 → the page sends tz = +180. Every fixture day index is built
  // with the SAME canonical `dayNumberOf` the db buckets with, so these tests exercise the real
  // db day axis in an eastern (positive-offset) timezone — the axis where the old local-offset
  // re-implementation was off by one.
  const TZ = 180
  /** UTC epoch-ms of Athens-local `hour:minute` on 2026-06-`day`. */
  const athens = (day: number, hour = 12, minute = 0) =>
    Date.UTC(2026, 5, day, hour, minute) - TZ * 60_000
  /** The db-axis day index for Athens-local noon on 2026-06-`day`. */
  const athensDay = (day: number) => dayNumberOf(athens(day), TZ)

  function makeStreaks(onDays: number[], todayNumber: number): BooleanStreaks {
    return {
      current: 2,
      longest: 5,
      onDays,
      firstDayNumber: onDays[0] ?? null,
      lastDayNumber: onDays[onDays.length - 1] ?? null,
      todayNumber,
    }
  }

  test('month stat counts on-days since the 1st, on the db day axis (UTC+3)', () => {
    // On-days: May 30 (outside the month) + June 1, 10, 14, 15. Today = 09:00 local, 15 Jun.
    const mayThirty = dayNumberOf(Date.UTC(2026, 4, 30, 12) - TZ * 60_000, TZ)
    const streaks = makeStreaks(
      [mayThirty, athensDay(1), athensDay(10), athensDay(14), athensDay(15)],
      athensDay(15),
    )
    const v = streakViz(streaks, TZ, athens(15, 9))
    expect(v.monthElapsed).toBe(15) // June 1–15
    expect(v.monthOnDays).toBe(4) // June 1, 10, 14, 15 — May 30 excluded
    expect(v.current).toBe(2)
    expect(v.longest).toBe(5)
  })

  test('month boundary holds just after local midnight on the 1st (UTC+3)', () => {
    // 00:30 Athens-local on 1 June is still 31 May in UTC — the exact spot an inverted or
    // process-local offset lands in the wrong month (a 32-day "elapsed" May instead of 1-day June).
    const now = athens(1, 0, 30)
    const streaks = makeStreaks([athensDay(1)], athensDay(1))
    const v = streakViz(streaks, TZ, now)
    expect(v.monthElapsed).toBe(1)
    expect(v.monthOnDays).toBe(1)
  })

  test('builds a week-column grid ending on today, marks on-days', () => {
    const today = athensDay(15) // 15 Jun 2026 — a Monday
    const streaks = makeStreaks([today - 1, today], today)
    const v = streakViz(streaks, TZ, athens(15, 9), 4)
    expect(v.columns).toHaveLength(4)
    expect(v.columns[0]?.cells).toHaveLength(7)
    expect(v.dayLabels).toHaveLength(7)
    // Monday sits in row index 1 of the last column, and both on-days render on.
    const lastCol = v.columns[3]
    expect(lastCol?.cells[1]?.on).toBe(true) // Monday (today)
    expect(lastCol?.cells[0]?.on).toBe(true) // Sunday (yesterday)
    expect(lastCol?.cells[2]?.real).toBe(false) // Tuesday hasn't happened yet
  })
})

// --- detail: select distribution ------------------------------------------------------------

describe('selectDistribution', () => {
  test('computes per-option share', () => {
    const t = makeTracker({
      input_type: 'single_select',
      config: { input_type: 'single_select', options: ['Low', 'High'] },
    })
    const entries = [
      makeEntry({ id: '1', value: 'Low' }),
      makeEntry({ id: '2', value: 'High' }),
      makeEntry({ id: '3', value: 'High' }),
    ]
    const dist = selectDistribution(entries, t)
    expect(dist).toHaveLength(2)
    expect(dist.find((d) => d.label === 'High')?.pct).toBe('67%')
    expect(dist.find((d) => d.label === 'Low')?.pct).toBe('33%')
  })
})

// --- the form: config-union builder ---------------------------------------------------------

describe('trackerWritePayload / buildTrackerConfig', () => {
  test('scale → bounds + optional labels', () => {
    const cfg = buildTrackerConfig({
      ...EMPTY_TRACKER_FORM,
      name: 'Energy',
      input_type: 'scale',
      scaleMin: 1,
      scaleMax: 10,
      lowLabel: 'Flat',
      highLabel: 'Wired',
    })
    expect(cfg).toEqual({ input_type: 'scale', min: 1, max: 10, labels: ['Flat', 'Wired'] })
  })

  test('number → unit omitted when blank', () => {
    expect(buildTrackerConfig({ ...EMPTY_TRACKER_FORM, input_type: 'number', unit: '' })).toEqual({
      input_type: 'number',
    })
    expect(
      buildTrackerConfig({ ...EMPTY_TRACKER_FORM, input_type: 'number', unit: 'cups' }),
    ).toEqual({ input_type: 'number', unit: 'cups' })
  })

  test('select → cleans empty options', () => {
    const cfg = buildTrackerConfig({
      ...EMPTY_TRACKER_FORM,
      input_type: 'single_select',
      options: ['Low', '  ', 'High'],
    })
    expect(cfg).toEqual({ input_type: 'single_select', options: ['Low', 'High'] })
  })

  test('boolean / text → bare config', () => {
    expect(buildTrackerConfig({ ...EMPTY_TRACKER_FORM, input_type: 'boolean' })).toEqual({
      input_type: 'boolean',
    })
    expect(buildTrackerConfig({ ...EMPTY_TRACKER_FORM, input_type: 'text' })).toEqual({
      input_type: 'text',
    })
  })

  test('full payload trims the name', () => {
    const p = trackerWritePayload({
      ...EMPTY_TRACKER_FORM,
      name: '  Sleep  ',
      input_type: 'number',
    })
    expect(p.name).toBe('Sleep')
    expect(p.input_type).toBe('number')
  })
})

describe('canSubmitTracker', () => {
  test('name required; scale needs min<max; select needs an option', () => {
    expect(canSubmitTracker({ ...EMPTY_TRACKER_FORM, name: '' })).toBe(false)
    expect(canSubmitTracker({ ...EMPTY_TRACKER_FORM, name: 'X', scaleMin: 5, scaleMax: 5 })).toBe(
      false,
    )
    expect(canSubmitTracker({ ...EMPTY_TRACKER_FORM, name: 'X' })).toBe(true)
    expect(
      canSubmitTracker({
        ...EMPTY_TRACKER_FORM,
        name: 'X',
        input_type: 'single_select',
        options: ['', ''],
      }),
    ).toBe(false)
  })
})

describe('trackerFormValues', () => {
  test('round-trips a scale tracker with labels', () => {
    const cfg: TrackerConfig = { input_type: 'scale', min: 0, max: 10, labels: ['Lo', 'Hi'] }
    const v = trackerFormValues(makeTracker({ config: cfg }))
    expect(v).toMatchObject({ scaleMin: 0, scaleMax: 10, lowLabel: 'Lo', highLabel: 'Hi' })
  })

  test('round-trips select options', () => {
    const t = makeTracker({
      input_type: 'multi_select',
      config: { input_type: 'multi_select', options: ['a', 'b'] },
    })
    expect(trackerFormValues(t).options).toEqual(['a', 'b'])
  })
})
