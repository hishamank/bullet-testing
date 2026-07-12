import { expect, test } from 'vitest'
import { createTestDb } from '../client'
import { seedOwnerAndBullet } from '../test-helpers'
import { createActivity } from './activities'
import {
  type Correlation,
  dayNumberOf,
  findQuietPattern,
  trackerActivityCorrelation,
  trackerBooleanStreaks,
  trackerDailySeries,
  trackerYearInPixels,
} from './tracker-analytics'
import { createTrackerEntry } from './trackerEntries'
import { createTracker } from './trackers'

const MS_PER_DAY = 86_400_000
/** Epoch-ms at UTC-noon of a given day index — with tz=0 this lands squarely on `dayIndex`. */
const dayMs = (dayIndex: number, hour = 12) => dayIndex * MS_PER_DAY + hour * 3_600_000

function scaleTracker(db: ReturnType<typeof createTestDb>['db'], ownerId: string, name = 'Mood') {
  return createTracker(db, {
    owner_id: ownerId,
    source_bullet_id: null,
    name,
    input_type: 'scale',
    config: { input_type: 'scale', min: 1, max: 5 },
  })
}

function logValue(
  db: ReturnType<typeof createTestDb>['db'],
  ownerId: string,
  trackerId: string,
  value: number | boolean,
  logged_at: number,
) {
  return createTrackerEntry(db, {
    owner_id: ownerId,
    source_bullet_id: null,
    tracker_id: trackerId,
    value,
    logged_at,
  })
}

test('dayNumberOf: pure epoch-day arithmetic, timezone-shiftable', () => {
  expect(dayNumberOf(0, 0)).toBe(0)
  expect(dayNumberOf(MS_PER_DAY, 0)).toBe(1)
  // 23:30 UTC shifted +60min crosses into the next local day.
  expect(dayNumberOf(23.5 * 3_600_000, 60)).toBe(1)
  expect(dayNumberOf(23.5 * 3_600_000, 0)).toBe(0)
})

test('trackerDailySeries: buckets by day, means the values, keeps the last-logged value', () => {
  const { db } = createTestDb()
  const { ownerId } = seedOwnerAndBullet(db)
  const t = scaleTracker(db, ownerId)
  logValue(db, ownerId, t.id, 2, dayMs(10, 8))
  logValue(db, ownerId, t.id, 4, dayMs(10, 20)) // same day, later → mean 3, last 4
  logValue(db, ownerId, t.id, 5, dayMs(12, 9))

  const series = trackerDailySeries(db, t.id)
  expect(series.map((b) => b.dayNumber)).toEqual([10, 12])
  expect(series[0]).toMatchObject({ count: 2, sum: 6, mean: 3, min: 2, max: 4, last: 4 })
  expect(series[1]).toMatchObject({ count: 1, mean: 5, last: 5 })
})

test('trackerDailySeries: ignores non-numeric values and soft-deleted entries', () => {
  const { db } = createTestDb()
  const { ownerId } = seedOwnerAndBullet(db)
  const t = createTracker(db, {
    owner_id: ownerId,
    source_bullet_id: null,
    name: 'Notes',
    input_type: 'text',
    config: { input_type: 'text' },
  })
  createTrackerEntry(db, {
    owner_id: ownerId,
    source_bullet_id: null,
    tracker_id: t.id,
    value: 'a good day',
    logged_at: dayMs(3),
  })
  expect(trackerDailySeries(db, t.id)).toEqual([])
})

test('trackerYearInPixels: one mean-per-day within the year, carries scale bounds', () => {
  const { db } = createTestDb()
  const { ownerId } = seedOwnerAndBullet(db)
  const t = scaleTracker(db, ownerId)
  // Day 20 is 1970-01-21 (year 1970); use a far day for a different year.
  const inYear = dayNumberOf(Date.UTC(2026, 2, 5, 12), 0) // 2026-03-05
  const otherYear = dayNumberOf(Date.UTC(2025, 5, 1, 12), 0)
  logValue(db, ownerId, t.id, 3, inYear * MS_PER_DAY + 12 * 3_600_000)
  logValue(db, ownerId, t.id, 5, inYear * MS_PER_DAY + 20 * 3_600_000) // same day → mean 4
  logValue(db, ownerId, t.id, 2, otherYear * MS_PER_DAY + 12 * 3_600_000)

  const yip = trackerYearInPixels(db, t.id, 2026)
  expect(yip.scaleMin).toBe(1)
  expect(yip.scaleMax).toBe(5)
  expect(yip.days).toHaveLength(1)
  expect(yip.days[0]).toMatchObject({ month: 2, dayOfMonth: 5, mean: 4, count: 2 })
  expect(yip.min).toBe(4)
  expect(yip.max).toBe(4)
})

test('trackerBooleanStreaks: current (with yesterday grace) + longest run', () => {
  const { db } = createTestDb()
  const { ownerId } = seedOwnerAndBullet(db)
  const t = createTracker(db, {
    owner_id: ownerId,
    source_bullet_id: null,
    name: 'Meditate',
    input_type: 'boolean',
    config: { input_type: 'boolean' },
  })
  const today = 100
  const now = dayMs(today, 9)
  // A 3-day run ending today; an earlier broken 2-day run.
  logValue(db, ownerId, t.id, true, dayMs(today - 2))
  logValue(db, ownerId, t.id, true, dayMs(today - 1))
  logValue(db, ownerId, t.id, true, dayMs(today))
  logValue(db, ownerId, t.id, true, dayMs(today - 10))
  logValue(db, ownerId, t.id, true, dayMs(today - 9))
  logValue(db, ownerId, t.id, false, dayMs(today - 5)) // false doesn't count as on

  const s = trackerBooleanStreaks(db, t.id, { now })
  expect(s.current).toBe(3)
  expect(s.longest).toBe(3)
  expect(s.onDays).toEqual([today - 10, today - 9, today - 2, today - 1, today])
  expect(s.todayNumber).toBe(today)
})

test('trackerBooleanStreaks: grace when today unlogged but yesterday on; broken otherwise', () => {
  const { db } = createTestDb()
  const { ownerId } = seedOwnerAndBullet(db)
  const t = createTracker(db, {
    owner_id: ownerId,
    source_bullet_id: null,
    name: 'Run',
    input_type: 'boolean',
    config: { input_type: 'boolean' },
  })
  const today = 200
  logValue(db, ownerId, t.id, true, dayMs(today - 2))
  logValue(db, ownerId, t.id, true, dayMs(today - 1))
  // today not logged → grace anchors on yesterday
  expect(trackerBooleanStreaks(db, t.id, { now: dayMs(today, 9) }).current).toBe(2)
  // two days later, the run is stale → current 0
  expect(trackerBooleanStreaks(db, t.id, { now: dayMs(today + 2, 9) }).current).toBe(0)
})

test('trackerActivityCorrelation: honest with/without means, threshold-gated', () => {
  const { db } = createTestDb()
  const { ownerId } = seedOwnerAndBullet(db)
  const t = scaleTracker(db, ownerId)

  // 6 "run" days at mood 4, 6 non-run days at mood 3.
  for (let i = 0; i < 6; i++) {
    logValue(db, ownerId, t.id, 4, dayMs(i))
    createActivity(db, {
      owner_id: ownerId,
      source_bullet_id: null,
      name: 'Run',
      occurred_at: dayMs(i, 7),
      tracker_id: null,
      notes: null,
      quantity: null,
      unit: null,
    })
  }
  for (let i = 10; i < 16; i++) logValue(db, ownerId, t.id, 3, dayMs(i))

  const c = trackerActivityCorrelation(db, ownerId, t.id, 'run', { minDays: 5 })
  expect(c).not.toBeNull()
  const corr = c as Correlation
  expect(corr.withDays).toBe(6)
  expect(corr.withoutDays).toBe(6)
  expect(corr.withMean).toBeCloseTo(4)
  expect(corr.withoutMean).toBeCloseTo(3)
  expect(corr.delta).toBeCloseTo(1)

  // Raising the threshold above the sample hides it.
  expect(trackerActivityCorrelation(db, ownerId, t.id, 'run', { minDays: 7 })).toBeNull()
})

test('findQuietPattern: returns the strongest qualifying pattern, else null', () => {
  const { db } = createTestDb()
  const { ownerId } = seedOwnerAndBullet(db)
  const mood = scaleTracker(db, ownerId, 'Mood')

  for (let i = 0; i < 6; i++) {
    logValue(db, ownerId, mood.id, 5, dayMs(i))
    createActivity(db, {
      owner_id: ownerId,
      source_bullet_id: null,
      name: 'Run',
      occurred_at: dayMs(i, 7),
      tracker_id: null,
      notes: null,
      quantity: null,
      unit: null,
    })
  }
  for (let i = 10; i < 16; i++) logValue(db, ownerId, mood.id, 2, dayMs(i))

  const best = findQuietPattern(db, ownerId, { minDays: 5 })
  expect(best?.activityName).toBe('Run')
  expect(best?.trackerName).toBe('Mood')
  expect(best?.delta).toBeCloseTo(3)

  // With a too-high threshold, nothing qualifies.
  expect(findQuietPattern(db, ownerId, { minDays: 8 })).toBeNull()
})
