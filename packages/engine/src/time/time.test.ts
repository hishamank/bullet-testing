import { describe, expect, test } from 'vite-plus/test'
import { resolveDateAnswer, resolveEnd, resolveWhen } from './when'
import { safeTimezone, zonedParts, zonedToEpoch } from './zoned'

// Thursday 2026-10-15 09:12 in Paris (CEST, UTC+2) = 07:12Z.
const PARIS = 'Europe/Paris'
const CAPTURED = Date.UTC(2026, 9, 15, 7, 12)
const ctx = { capturedAt: CAPTURED, timezone: PARIS }

/** Paris wall time → epoch, for readable expectations. */
const paris = (month: number, day: number, hour = 0, minute = 0) =>
  zonedToEpoch({ year: 2026, month, day, hour, minute }, PARIS)

describe('zoned arithmetic', () => {
  test('zonedParts reads the local wall clock and weekday', () => {
    expect(zonedParts(CAPTURED, PARIS)).toEqual({
      year: 2026,
      month: 10,
      day: 15,
      hour: 9,
      minute: 12,
      weekday: 4,
    })
  })

  test('zonedToEpoch round-trips across the DST change (CEST → CET on Oct 25)', () => {
    expect(paris(10, 15, 9, 12)).toBe(CAPTURED)
    expect(paris(10, 29, 15)).toBe(Date.UTC(2026, 9, 29, 14)) // CET, UTC+1
  })

  test('other zones', () => {
    expect(zonedToEpoch({ year: 2026, month: 1, day: 1, hour: 9 }, 'America/New_York')).toBe(
      Date.UTC(2026, 0, 1, 14),
    )
    expect(zonedToEpoch({ year: 2026, month: 1, day: 1, hour: 9 }, 'Asia/Kolkata')).toBe(
      Date.UTC(2026, 0, 1, 3, 30),
    )
  })

  test('an unknown zone falls back to UTC instead of throwing', () => {
    expect(safeTimezone('Mars/Olympus_Mons')).toBe('UTC')
    expect(zonedToEpoch({ year: 2026, month: 1, day: 1, hour: 9 }, 'Mars/Olympus_Mons')).toBe(
      Date.UTC(2026, 0, 1, 9),
    )
  })
})

describe('resolveWhen — plans (future)', () => {
  const f = (text: string) => resolveWhen(text, ctx, 'future')

  test('tomorrow / today / day after tomorrow are date-only at local midnight', () => {
    expect(f('call mom tomorrow')).toEqual({ at: paris(10, 16), hasTime: false })
    expect(f('today')).toEqual({ at: paris(10, 15), hasTime: false })
    expect(f('the day after tomorrow')).toEqual({ at: paris(10, 17), hasTime: false })
  })

  test('"Thursday 3pm" said on a Thursday morning is today at 15:00 local', () => {
    expect(f('dentist Thursday 3pm')).toEqual({ at: paris(10, 15, 15), hasTime: true })
  })

  test('weekdays resolve to the coming occurrence; "next" skips today', () => {
    expect(f('friday')).toEqual({ at: paris(10, 16), hasTime: false })
    expect(f('on Tuesday at 10:30')).toEqual({ at: paris(10, 20, 10, 30), hasTime: true })
    expect(f('next thursday')).toEqual({ at: paris(10, 22), hasTime: false })
  })

  test('across the DST change the local hour is kept', () => {
    const later = { capturedAt: paris(10, 22, 9), timezone: PARIS }
    expect(resolveWhen('next Thursday 3pm', later, 'future')).toEqual({
      at: Date.UTC(2026, 9, 29, 14),
      hasTime: true,
    })
  })

  test('time formats', () => {
    expect(f('tomorrow at 3:30 pm')?.at).toBe(paris(10, 16, 15, 30))
    expect(f('tomorrow 15:45')?.at).toBe(paris(10, 16, 15, 45))
    expect(f('tomorrow at noon')?.at).toBe(paris(10, 16, 12))
    expect(f('tomorrow 12am')?.at).toBe(paris(10, 16, 0))
    expect(f('tomorrow at 3')?.at).toBe(paris(10, 16, 15)) // "at 3" means the afternoon
    expect(f('tomorrow morning')?.at).toBe(paris(10, 16, 9))
    expect(f('tonight')?.at).toBe(paris(10, 15, 20))
  })

  test('a bare time already past today rolls to tomorrow', () => {
    expect(f('call bank at 8am')).toEqual({ at: paris(10, 16, 8), hasTime: true })
    expect(f('call bank at 5pm')).toEqual({ at: paris(10, 15, 17), hasTime: true })
  })

  test('relative offsets', () => {
    expect(f('in 2 hours')).toEqual({ at: CAPTURED + 2 * 3_600_000, hasTime: true })
    expect(f('in three days')).toEqual({ at: paris(10, 18), hasTime: false })
    expect(f('in a week')).toEqual({ at: paris(10, 22), hasTime: false })
  })

  test('explicit dates', () => {
    expect(f('2026-11-02')).toEqual({ at: paris(11, 2), hasTime: false })
    expect(f('2026-11-02 09:00')).toEqual({ at: paris(11, 2, 9), hasTime: true })
    expect(f('Oct 22 at 7pm')).toEqual({ at: paris(10, 22, 19), hasTime: true })
    expect(f('22nd of October')).toEqual({ at: paris(10, 22), hasTime: false })
    // A month/day already past this year means next year.
    expect(f('march 3')?.at).toBe(zonedToEpoch({ year: 2027, month: 3, day: 3 }, PARIS))
  })

  test('no date or time → null; ordinary words are not dates', () => {
    expect(f('buy milk')).toBeNull()
    expect(f('good morning, feeling great')).toBeNull()
    expect(f('sat down with sun on my face')).toBeNull()
    expect(f('ran 5k')).toBeNull()
  })
})

describe('resolveWhen — records (past)', () => {
  const p = (text: string) => resolveWhen(text, ctx, 'past')

  test('yesterday / last night / weekdays lean backwards', () => {
    expect(p('ran 5k yesterday')).toEqual({ at: paris(10, 14), hasTime: false })
    expect(p('slept badly last night')).toEqual({ at: paris(10, 14, 20), hasTime: true })
    expect(p('went climbing monday')).toEqual({ at: paris(10, 12), hasTime: false })
    expect(p('thursday')).toEqual({ at: paris(10, 15), hasTime: false })
  })

  test('a bare time later than the capture is yesterday', () => {
    expect(p('ran at 7am')).toEqual({ at: paris(10, 15, 7), hasTime: true })
    expect(p('drank wine at 9pm')).toEqual({ at: paris(10, 14, 21), hasTime: true })
  })

  test('"N ago"', () => {
    expect(p('2 hours ago')?.at).toBe(CAPTURED - 2 * 3_600_000)
    expect(p('3 days ago')?.at).toBe(paris(10, 12))
  })
})

describe('resolveWhen — French and Lebanese Arabic (Arabizi) day words', () => {
  const f = (text: string) => resolveWhen(text, ctx, 'future')
  const p = (text: string) => resolveWhen(text, ctx, 'past')

  test('days', () => {
    for (const w of ['bukra', 'bokra', 'demain', 'Demain']) expect(f(w)?.at).toBe(paris(10, 16))
    for (const w of ['ba3d bukra', 'après-demain', 'apres demain'])
      expect(f(w)?.at).toBe(paris(10, 17))
    for (const w of ['mbere7', 'embare7', 'hier']) expect(p(w)?.at).toBe(paris(10, 14))
    expect(p('avant-hier')?.at).toBe(paris(10, 13))
    for (const w of ['بكرا', 'بكرة', 'لازم اتصل بالبنك بكرا.']) expect(f(w)?.at).toBe(paris(10, 16))
    expect(p('مبارح')?.at).toBe(paris(10, 14))
    expect(f('اليوم')?.at).toBe(paris(10, 15))
    for (const w of ['lyom', 'el yom', "aujourd'hui", 'aujourd’hui'])
      expect(f(w)?.at).toBe(paris(10, 15))
  })

  test('weekdays and times', () => {
    expect(f('jeudi à 15h')).toEqual({ at: paris(10, 15, 15), hasTime: true })
    expect(f('jeudi prochain')?.at).toBe(paris(10, 22))
    expect(f('el jem3a')?.at).toBe(paris(10, 16))
    expect(f('yom el sabt')?.at).toBe(paris(10, 17))
    expect(f('demain à 9h30')).toEqual({ at: paris(10, 16, 9, 30), hasTime: true })
    expect(f('15h')).toEqual({ at: paris(10, 15, 15), hasTime: true })
    // A time right after the day, no "à" (seen live: "RDV chez le coiffeur jeudi 15h").
    expect(f('jeudi 15h')).toEqual({ at: paris(10, 15, 15), hasTime: true })
    expect(f('RDV chez le coiffeur jeudi 15h')).toEqual({ at: paris(10, 15, 15), hasTime: true })
    expect(f('demain 9h')).toEqual({ at: paris(10, 16, 9), hasTime: true })
    expect(f('bukra 18h')).toEqual({ at: paris(10, 16, 18), hasTime: true })
    expect(p('hier soir')).toEqual({ at: paris(10, 14, 20), hasTime: true })
    expect(f('dans 2 heures')?.at).toBe(CAPTURED + 2 * 3_600_000)
    expect(p('il y a 3 jours')?.at).toBe(paris(10, 12))
  })

  test('look-alikes are not dates', () => {
    expect(p('slept 6h')).toBeNull()
    expect(p('slept 6h today')?.hasTime).toBe(false)
    expect(f('wa7ad')).toBeNull()
    expect(f('yom hilo')).toBeNull()
  })
})

describe('resolveEnd', () => {
  test('a bare end time lands on the start day', () => {
    const start = paris(10, 16, 15)
    expect(resolveEnd('5pm', start, PARIS)).toBe(paris(10, 16, 17))
  })

  test('an end before the start is dropped', () => {
    const start = paris(10, 16, 15)
    expect(resolveEnd('yesterday', start, PARIS)).toBeNull()
  })
})

describe('resolveDateAnswer', () => {
  test('"Today" / "Next Thursday" move the day and keep the time of day', () => {
    const at = paris(10, 15, 15)
    expect(resolveDateAnswer('Today', at, ctx)).toBe(at)
    expect(resolveDateAnswer('Next Thursday', at, ctx)).toBe(paris(10, 22, 15))
  })

  test('without a current value a day is its local midnight; an option with a time wins', () => {
    expect(resolveDateAnswer('Next Thursday', null, ctx)).toBe(paris(10, 22))
    expect(resolveDateAnswer('tomorrow 8am', paris(10, 15, 15), ctx)).toBe(paris(10, 16, 8))
  })

  test('an option naming no date is null', () => {
    expect(resolveDateAnswer('Yes', null, ctx)).toBeNull()
  })
})
