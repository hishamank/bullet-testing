/**
 * Dates and times as the Journal shows them, in a given IANA zone. Pure (Intl only, through
 * `@bullet/engine`'s zone helpers), so every label is testable.
 */

import { addDays, type ZonedParts, zonedParts, zonedToEpoch } from '@bullet/engine'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n: number) => String(n).padStart(2, '0')

export const DAY_MS = 86_400_000

/** "2026-10-15": sorts and compares as a calendar day in `tz`. */
export function dayKey(at: number, tz: string): string {
  const p = zonedParts(at, tz)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

/** Midnight (local) of the day `at` falls on, plus `offset` days. */
export function startOfDay(at: number, tz: string, offset = 0): number {
  const p = zonedParts(at, tz)
  return zonedToEpoch(addDays(p, offset), tz)
}

/** Whole calendar days from `now`'s day to `at`'s day (negative = in the past). */
export function dayDiff(at: number, now: number, tz: string): number {
  const a = zonedParts(at, tz)
  const b = zonedParts(now, tz)
  return Math.round(
    (Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day)) / DAY_MS,
  )
}

/** "08:40" (24-hour, like the design). */
export function clock(at: number, tz: string): string {
  const p = zonedParts(at, tz)
  return `${pad(p.hour)}:${pad(p.minute)}`
}

function dateWords(p: ZonedParts, withYear: boolean): string {
  return `${p.day} ${MONTHS[p.month - 1]}${withYear ? ` ${p.year}` : ''}`
}

/** "Thu 23": a short day for lists. */
export function shortDay(at: number, tz: string): string {
  const p = zonedParts(at, tz)
  return `${WEEKDAYS[p.weekday]} ${p.day}`
}

/** A stream section title: "Today", "Yesterday", "Mon 12 Oct", "Mon 12 Oct 2025". */
export function dayTitle(at: number, now: number, tz: string): string {
  const diff = dayDiff(at, now, tz)
  if (diff === 0) return 'Today'
  if (diff === -1) return 'Yesterday'
  if (diff === 1) return 'Tomorrow'
  const p = zonedParts(at, tz)
  const sameYear = p.year === zonedParts(now, tz).year
  return `${WEEKDAYS[p.weekday]} ${dateWords(p, !sameYear)}`
}

/** "today 08:40", "yesterday 19:22", "Thu 22:05" (this past week), "12 Oct 22:05". */
export function whenLabel(at: number, now: number, tz: string): string {
  const diff = dayDiff(at, now, tz)
  const time = clock(at, tz)
  if (diff === 0) return `today ${time}`
  if (diff === -1) return `yesterday ${time}`
  if (diff === 1) return `tomorrow ${time}`
  const p = zonedParts(at, tz)
  if (diff < 0 && diff > -7) return `${WEEKDAYS[p.weekday]} ${time}`
  return `${dateWords(p, p.year !== zonedParts(now, tz).year)} ${time}`
}

/** "Thu 23 Oct, 15:00" (a thing's date in full). */
export function fullWhen(at: number, now: number, tz: string): string {
  const p = zonedParts(at, tz)
  return `${WEEKDAYS[p.weekday]} ${dateWords(p, p.year !== zonedParts(now, tz).year)}, ${clock(at, tz)}`
}

/** A recording's length: "0:48", "3:12", "1:02:05". */
export function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** VoiceOver reads "3 minutes 12 seconds" better than "3:12". */
export function spokenDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  const parts = []
  if (m > 0) parts.push(`${m} ${m === 1 ? 'minute' : 'minutes'}`)
  if (s > 0 || m === 0) parts.push(`${s} ${s === 1 ? 'second' : 'seconds'}`)
  return parts.join(' ')
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
