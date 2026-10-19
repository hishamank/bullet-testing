import { describe, expect, test } from 'vite-plus/test'
import { T0 } from '../../test/db'
import { clock, dayDiff, dayTitle, duration, fullWhen, spokenDuration, whenLabel } from './format'

const TZ = 'Europe/Paris'
const H = 3_600_000
const D = 24 * H

describe('journal dates (Thu 15 Oct 2026, 09:12 in Paris)', () => {
  test('day titles', () => {
    expect(dayTitle(T0, T0, TZ)).toBe('Today')
    expect(dayTitle(T0 - D, T0, TZ)).toBe('Yesterday')
    expect(dayTitle(T0 + D, T0, TZ)).toBe('Tomorrow')
    expect(dayTitle(T0 - 3 * D, T0, TZ)).toBe('Mon 12 Oct')
    expect(dayTitle(T0 - 365 * D, T0, TZ)).toBe('Wed 15 Oct 2025')
  })

  test('day boundaries follow the zone, not UTC', () => {
    // 23:30 UTC on the 14th is already 01:30 on the 15th in Paris.
    const lateUtc = Date.UTC(2026, 9, 14, 23, 30)
    expect(dayDiff(lateUtc, T0, TZ)).toBe(0)
    expect(dayDiff(lateUtc, T0, 'UTC')).toBe(-1)
    expect(clock(lateUtc, TZ)).toBe('01:30')
  })

  test('day differences survive the DST change (25 Oct 2026)', () => {
    const after = Date.UTC(2026, 9, 26, 8, 0)
    expect(dayDiff(after, T0, TZ)).toBe(11)
  })

  test('when labels', () => {
    expect(whenLabel(T0 - 30 * 60_000, T0, TZ)).toBe('today 08:42')
    expect(whenLabel(T0 - D, T0, TZ)).toBe('yesterday 09:12')
    expect(whenLabel(T0 - 2 * D, T0, TZ)).toBe('Tue 09:12')
    expect(whenLabel(T0 - 10 * D, T0, TZ)).toBe('5 Oct 09:12')
    expect(fullWhen(T0 + 8 * D, T0, TZ)).toBe('Fri 23 Oct, 09:12')
  })

  test('recording lengths', () => {
    expect(duration(48_000)).toBe('0:48')
    expect(duration(192_400)).toBe('3:12')
    expect(duration(3_725_000)).toBe('1:02:05')
    expect(spokenDuration(192_000)).toBe('3 minutes 12 seconds')
    expect(spokenDuration(60_000)).toBe('1 minute')
    expect(spokenDuration(0)).toBe('0 seconds')
  })
})
