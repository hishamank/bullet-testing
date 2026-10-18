import type { TrackerConfig } from '@bullet/core'
import { describe, expect, test } from 'vite-plus/test'
import { updateTrackerEntry } from '../../data/local'
import { openTestDb, T0, testDeps } from '../../test/db'
import { seedActivity, seedEntry, seedTracker, TZ } from './fixtures'
import {
  activityRows,
  loadActivityHistory,
  loadTrackerHistory,
  loadTrackers,
  parseEntryValue,
  sparkline,
  trackerRows,
} from './trackers'

const D = 86_400_000
const mood = { input_type: 'scale', min: 1, max: 5 } as const
const sleep = { input_type: 'number', unit: 'h', min: 0, max: 24 } as const

describe('sparklines', () => {
  test('scale readings draw a line of daily means over 14 days; gaps stay gaps', () => {
    const spark = sparkline(
      mood,
      [
        { value: 3, logged_at: T0 },
        { value: 5, logged_at: T0 - 1000 },
        { value: 2, logged_at: T0 - 13 * D },
        { value: 1, logged_at: T0 - 14 * D },
      ],
      [],
      T0,
      TZ,
    )
    expect(spark.mode).toBe('line')
    if (spark.mode !== 'line') return
    expect(spark.values).toHaveLength(14)
    expect(spark.values[13]).toBe(4)
    expect(spark.values[0]).toBe(2)
    expect(spark.values[5]).toBeNull()
  })

  test('other trackers (and linked activities) draw bars of counts', () => {
    const spark = sparkline(
      { input_type: 'boolean' },
      [{ value: true, logged_at: T0 }],
      [{ occurred_at: T0 - 1000 }, { occurred_at: T0 - 2 * D }],
      T0,
      TZ,
    )
    expect(spark).toMatchObject({ mode: 'bars' })
    if (spark.mode === 'bars') expect([spark.counts[13], spark.counts[11]]).toEqual([2, 1])
  })

  test('nothing in the window: no sparkline', () => {
    expect(sparkline(mood, [{ value: 3, logged_at: T0 - 30 * D }], [], T0, TZ)).toEqual({
      mode: 'none',
    })
  })
})

describe('tracker rows', () => {
  test('latest reading, a week count for bar rows, and "No readings yet"', () => {
    const db = openTestDb()
    const m = seedTracker(db, 'Mood', mood)
    const s = seedTracker(db, 'Sleep', sleep)
    const run = seedTracker(db, 'Run', { input_type: 'number', unit: 'km' })
    seedTracker(db, 'Water', { input_type: 'number', unit: 'glasses' })
    seedEntry(db, m, 4, T0 - D)
    seedEntry(db, m, 3, T0)
    seedEntry(db, s, 5, T0 - 40 * D)
    seedActivity(db, 'Run', T0, { tracker_id: run, quantity: 5, unit: 'km' })
    seedActivity(db, 'Run', T0 - 3 * D, { tracker_id: run, quantity: 4, unit: 'km' })
    const rows = trackerRows({ ...loadTrackers(db, T0, TZ), now: T0, tz: TZ })
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]))
    expect(byName.Mood).toMatchObject({ summary: '3 / 5 · today', spark: { mode: 'line' } })
    expect(byName.Mood?.sparkLabel).toBe(
      'Mood, last 14 days, 2 days with readings, between 3 and 4',
    )
    expect(byName.Sleep).toMatchObject({ summary: '5 h · 5 Sep', spark: { mode: 'none' } })
    expect(byName.Run).toMatchObject({
      summary: '5 km · today · 2 this week',
      spark: { mode: 'bars' },
    })
    expect(byName.Water).toMatchObject({ summary: 'No readings yet', hasReadings: false })
  })

  test('unlinked activities get a row per name', () => {
    const db = openTestDb()
    seedActivity(db, 'Yoga', T0 - D)
    seedActivity(db, 'yoga ', T0)
    seedActivity(db, 'Called mum', T0 - 2 * D)
    const rows = activityRows(loadTrackers(db, T0, TZ).activities, T0, TZ)
    expect(rows.map((r) => [r.name, r.summary])).toEqual([
      ['yoga', 'today · 2 this week'],
      ['Called mum', 'Tue'],
    ])
    expect(loadActivityHistory(db, 'YOGA')).toHaveLength(2)
  })

  test('history lists readings newest first; a fixed reading shows the new value', () => {
    const db = openTestDb()
    const m = seedTracker(db, 'Mood', mood)
    const old = seedEntry(db, m, 2, T0 - D)
    seedEntry(db, m, 4, T0)
    updateTrackerEntry(db, old, 3, testDeps())
    const h = loadTrackerHistory(db, m)
    expect(h.tracker?.name).toBe('Mood')
    expect(h.entries.map((e) => e.value)).toEqual([4, 3])
    expect(h.entries[1]?.user_edited_at).toBe(T0)
  })
})

describe('fixing a reading', () => {
  test('numbers: parsed, comma decimals, bounds explained', () => {
    expect(parseEntryValue('7,5', sleep)).toEqual({ ok: true, value: 7.5 })
    expect(parseEntryValue('30', sleep)).toEqual({ ok: false, error: 'Use a number from 0 to 24.' })
    expect(parseEntryValue('', sleep)).toMatchObject({ ok: false })
    expect(parseEntryValue('abc', sleep)).toMatchObject({ ok: false })
    expect(parseEntryValue('-1', { input_type: 'number', min: 0 })).toEqual({
      ok: false,
      error: 'Use 0 or more.',
    })
  })

  test('scales take whole numbers in range', () => {
    expect(parseEntryValue('4', mood)).toEqual({ ok: true, value: 4 })
    expect(parseEntryValue('3.5', mood)).toMatchObject({ ok: false })
    expect(parseEntryValue('9', mood)).toEqual({ ok: false, error: 'Use a number from 1 to 5.' })
  })

  test('selects, booleans and text', () => {
    const coffee: TrackerConfig = { input_type: 'single_select', options: ['tea', 'coffee'] }
    expect(parseEntryValue('coffee', coffee)).toEqual({ ok: true, value: 'coffee' })
    expect(parseEntryValue('juice', coffee)).toMatchObject({ ok: false })
    const extras: TrackerConfig = { input_type: 'multi_select', options: ['a', 'b'] }
    expect(parseEntryValue(['a', 'b'], extras)).toEqual({ ok: true, value: ['a', 'b'] })
    expect(parseEntryValue([], extras)).toMatchObject({ ok: false })
    expect(parseEntryValue(false, { input_type: 'boolean' })).toEqual({ ok: true, value: false })
    expect(parseEntryValue('  fine ', { input_type: 'text' })).toEqual({ ok: true, value: 'fine' })
  })
})
