/**
 * Deterministic resolution of the date/time phrases people put in bullets ("tomorrow",
 * "Thursday 3pm", "in 2 hours", "yesterday morning", "2026-10-22 15:00") into epoch ms, relative
 * to the bullet's CAPTURE time and time zone — never processing time (CLAUDE.md §5).
 *
 * The LLM is not trusted with calendar arithmetic: it quotes the phrase, this module does the math.
 * Phrases are English, plus the common French and Lebanese Arabic (Arabizi) day words, which are
 * mapped to English first ("bukra" → "tomorrow", "jeudi à 15h" → "thursday à 15h"). Unknown
 * phrases return null (the caller decides the fallback).
 */

import { addDays, safeTimezone, zonedParts, zonedToEpoch } from './zoned'

/** When and where a bullet was captured — the anchor for every relative date. */
export interface CaptureContext {
  /** Client clock at capture, epoch ms. */
  capturedAt: number
  /** The device's IANA zone at capture. */
  timezone: string
}

/**
 * Which way an ambiguous phrase leans. A plan ("call mom at 3pm", "Friday") resolves to the next
 * such time; a record ("ran at 7am", "Monday") to the most recent one.
 */
export type WhenDirection = 'future' | 'past'

export interface ResolvedWhen {
  /** Epoch ms. For a date-only phrase: local midnight starting that day. */
  at: number
  /** False when the phrase named a day but no time of day ("tomorrow", "Oct 22"). */
  hasTime: boolean
}

interface LocalDate {
  year: number
  month: number
  day: number
}

interface LocalTime {
  hour: number
  minute: number
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
}
const NUM = `(\\d+|${Object.keys(NUMBER_WORDS).join('|')})`

const toNumber = (s: string): number => NUMBER_WORDS[s] ?? Number(s)

// Full names plus unambiguous abbreviations only: "sat", "sun", "mon" are ordinary words.
const WEEKDAY_PATTERNS: [RegExp, number][] = [
  [/sunday/, 0],
  [/monday/, 1],
  [/tuesday|tues?/, 2],
  [/wednesday|wed/, 3],
  [/thursday|thurs?|thu/, 4],
  [/friday|fri/, 5],
  [/saturday/, 6],
]
const WEEKDAY_RE =
  /\b(?:(next|last|this|on|coming)\s+)?(sunday|monday|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday)\b/

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const MONTH_NAME = `(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`
const MONTH_DAY_RE = new RegExp(`\\b${MONTH_NAME}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`)
const DAY_MONTH_RE = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_NAME}\\b`)

const PART_OF_DAY: [RegExp, number][] = [
  [/\bmorning\b/, 9],
  [/\bafternoon\b/, 15],
  [/\bevening\b/, 19],
  [/\btonight\b|\bnight\b/, 20],
]

function monthIndex(name: string): number {
  return MONTHS.indexOf(name.slice(0, 3)) + 1
}

function weekdayNumber(name: string): number {
  for (const [re, n] of WEEKDAY_PATTERNS) if (re.test(name)) return n
  return 0
}

/**
 * "3pm", "3:30 pm", "15:00", "noon", "at 7", or — only when `partOfDay` — a part of day
 * ("tomorrow morning"). A lone "morning" ("good morning!") is not a time.
 */
function parseTime(s: string, partOfDay: boolean): LocalTime | null {
  const ampm = /\b(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)(?=\s|$|[^a-z])/.exec(s)
  if (ampm) {
    const h = Number(ampm[1])
    if (h >= 1 && h <= 12) {
      const pm = ampm[3]?.startsWith('p') ?? false
      return { hour: (h % 12) + (pm ? 12 : 0), minute: Number(ampm[2] ?? 0) }
    }
  }
  const clock = /\b([01]?\d|2[0-3])[:h]([0-5]\d)\b/.exec(s)
  if (clock) return { hour: Number(clock[1]), minute: Number(clock[2]) }
  // French "15h": only after "à"/"at"/"vers"…, or alone, so "slept 6h" is not a time of day.
  for (const m of s.matchAll(
    /(?:^|\s)(?:(à|a|at|vers|avant|before|by|until|till|@|3al|3a)\s*)?([01]?\d|2[0-3])h\b/g,
  ))
    if (m[1] !== undefined || s.trim() === m[0].trim()) return { hour: Number(m[2]), minute: 0 }
  if (/\b(noon|midday)\b/.test(s)) return { hour: 12, minute: 0 }
  if (/\bmidnight\b/.test(s)) return { hour: 0, minute: 0 }
  const bare = /\bat\s+(\d{1,2})\b(?!\s*(?:%|[.,]\d))/.exec(s)
  if (bare) {
    const h = Number(bare[1])
    // "at 3" in conversation almost always means the afternoon.
    if (h >= 1 && h <= 7) return { hour: h + 12, minute: 0 }
    if (h <= 23) return { hour: h, minute: 0 }
  }
  if (partOfDay) for (const [re, hour] of PART_OF_DAY) if (re.test(s)) return { hour, minute: 0 }
  return null
}

/** Parts of day count as a time only when anchored: "this morning", "tonight", "Friday evening". */
const ANCHORED_PART_OF_DAY = /\b(this|in the|last) (morning|afternoon|evening|night)\b|\btonight\b/

/** A calendar date named by the phrase, relative to `today`. */
function parseDate(s: string, today: LocalDate & { weekday: number }, dir: WhenDirection) {
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(s)
  if (iso) return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) }

  if (/\bday after tomorrow\b/.test(s)) return addDays(today, 2)
  if (/\b(tomorrow|tmrw|tmr)\b/.test(s)) return addDays(today, 1)
  if (/\bday before yesterday\b/.test(s)) return addDays(today, -2)
  if (/\b(yesterday|last night)\b/.test(s)) return addDays(today, -1)
  if (/\b(today|tonight|this (morning|afternoon|evening))\b/.test(s)) return today

  const wd = WEEKDAY_RE.exec(s)
  if (wd) {
    const target = weekdayNumber(wd[2] ?? '')
    const ahead = (target - today.weekday + 7) % 7
    const behind = (today.weekday - target + 7) % 7
    const modifier = wd[1]
    let delta: number
    if (modifier === 'next' || modifier === 'coming') delta = ahead === 0 ? 7 : ahead
    else if (modifier === 'last') delta = -(behind === 0 ? 7 : behind)
    else delta = dir === 'future' ? ahead : -behind
    return addDays(today, delta)
  }

  const md = MONTH_DAY_RE.exec(s)
  const dm = md ? null : DAY_MONTH_RE.exec(s)
  if (md || dm) {
    const month = monthIndex((md ? md[1] : dm?.[2]) ?? '')
    const day = Number(md ? md[2] : dm?.[1])
    if (day < 1 || day > 31) return null
    let year = today.year
    const key = (d: LocalDate) => d.year * 10_000 + d.month * 100 + d.day
    if (dir === 'future' && key({ year, month, day }) < key(today)) year += 1
    if (dir === 'past' && key({ year, month, day }) > key(today)) year -= 1
    return { year, month, day }
  }
  return null
}

const W = (words: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${words})(?![\\p{L}\\p{N}])`, 'gu')

/** French, Arabizi and Arabic date words → English, longest phrases first. Input is lowercased. */
const DATE_WORDS: [RegExp, string][] = [
  [W('apr[eè]s[- ]demain|ba3e?d bu?o?kra|بعد بكر[اةه]'), 'day after tomorrow'],
  [W('avant[- ]hier|aw+al mbe?a?re7|اول امبارح'), 'day before yesterday'],
  [W('hier soir'), 'last night'],
  [W('bu?o?krah?|demain|بكر[اةه]'), 'tomorrow'],
  [W('e?mb[ae]re?7|mberi7|hier|ا?مبارح|البارحة'), 'yesterday'],
  [W('ce soir|cette nuit|(?:e?l ?)?leyle|الليلة'), 'tonight'],
  [W('ce matin|(?:e?l ?)?sob7|(?:e?l ?)?saba7|الصبح'), 'this morning'],
  [W('cet apr[eè]s[- ]midi'), 'this afternoon'],
  [W("aujourd['’]?hui|(?:e?l ?)y(?:o|ou|aw)m|اليوم"), 'today'],
  [W('midi'), 'noon'],
  [W('minuit'), 'midnight'],
  [W('lundi'), 'monday'],
  [W('mardi'), 'tuesday'],
  [W('mercredi'), 'wednesday'],
  [W('jeudi|(?:e?l ?)?(?:kh|5)amis'), 'thursday'],
  [W('vendredi|(?:e?l ?)?j[eou]m(?:3a|aa)'), 'friday'],
  [W('samedi|(?:e?l ?)?sabt'), 'saturday'],
  [W('dimanche|(?:e?l ?)?a[7h]ad'), 'sunday'],
  [W('(sunday|monday|tuesday|wednesday|thursday|friday|saturday) prochaine?'), 'next $1'],
  [W('(sunday|monday|tuesday|wednesday|thursday|friday|saturday) derni[eè]re?'), 'last $1'],
  [W('dans (\\d+) (minute|heure|jour|semaine)s?'), 'in $1 $2s'],
  [W('il y a (\\d+) (minute|heure|jour|semaine)s?'), '$1 $2s ago'],
  [W('heures?'), 'hours'],
  [W('jours?'), 'days'],
  [W('semaines?'), 'weeks'],
]

/** Map French / Arabizi date words in a lowercased phrase to the English ones parsed below. */
export function englishDateWords(s: string): string {
  return DATE_WORDS.reduce((acc, [re, en]) => acc.replace(re, en), s)
}

/**
 * Resolve the date/time phrase in `text` (which may be a whole sentence) against the capture
 * context. Returns null when the text names no date or time.
 */
export function resolveWhen(
  text: string,
  ctx: CaptureContext,
  direction: WhenDirection,
): ResolvedWhen | null {
  const s = englishDateWords(text.toLowerCase().replace(/\s+/g, ' '))
  const timezone = safeTimezone(ctx.timezone)
  const now = zonedParts(ctx.capturedAt, timezone)
  const today = { year: now.year, month: now.month, day: now.day, weekday: now.weekday }

  // "in 2 hours", "3 days ago": relative offsets.
  const rel = new RegExp(`\\bin ${NUM} (minute|min|hour|hr|day|week)s?\\b`).exec(s)
  const ago = rel ? null : new RegExp(`\\b${NUM} (minute|min|hour|hr|day|week)s? ago\\b`).exec(s)
  const offset = rel ?? ago
  if (offset) {
    const sign = rel ? 1 : -1
    const n = toNumber(offset[1] ?? '') * sign
    const unit = offset[2] ?? ''
    if (unit.startsWith('min')) return { at: ctx.capturedAt + n * MINUTE, hasTime: true }
    if (unit.startsWith('h')) return { at: ctx.capturedAt + n * HOUR, hasTime: true }
    const date = addDays(today, unit === 'week' ? n * 7 : n)
    const time = parseTime(s, true)
    return time
      ? { at: zonedToEpoch({ ...date, ...time }, timezone), hasTime: true }
      : { at: zonedToEpoch(date, timezone), hasTime: false }
  }

  const date = parseDate(s, today, direction)
  const time = parseTime(s, date !== null || ANCHORED_PART_OF_DAY.test(s))
  if (!date && !time) return null
  if (date && !time) return { at: zonedToEpoch(date, timezone), hasTime: false }

  const t = time as LocalTime
  if (date) return { at: zonedToEpoch({ ...date, ...t }, timezone), hasTime: true }

  // A time with no day: the next such time for a plan, the last one for a record.
  let at = zonedToEpoch({ ...today, ...t }, timezone)
  if (direction === 'future' && at < ctx.capturedAt)
    at = zonedToEpoch({ ...addDays(today, 1), ...t }, timezone)
  if (direction === 'past' && at > ctx.capturedAt)
    at = zonedToEpoch({ ...addDays(today, -1), ...t }, timezone)
  return { at, hasTime: true }
}

/**
 * Resolve an END phrase ("5pm", "until 6", "Sunday") for something starting at `startsAt`: a bare
 * time lands on the start's day, or the next day when it would end before it starts.
 */
export function resolveEnd(text: string, startsAt: number, timezone: string): number | null {
  const end = resolveWhen(text, { capturedAt: startsAt, timezone }, 'future')
  if (!end || end.at < startsAt) return null
  return end.at
}

/**
 * A bare weekday that names TODAY ("dentist Thursday" said on a Thursday) is ambiguous: today, or
 * a week from now? Returns the weekday as written (capitalised) when so, else null. The resolver
 * still picks today; this only lets the engine ask.
 */
export function ambiguousWeekday(text: string, ctx: CaptureContext): string | null {
  const s = englishDateWords(text.toLowerCase())
  const wd = WEEKDAY_RE.exec(s)
  if (!wd || (wd[1] !== undefined && wd[1] !== 'on')) return null
  if (/\b(today|tonight|tomorrow|this (morning|afternoon|evening))\b/.test(s)) return null
  const now = zonedParts(ctx.capturedAt, safeTimezone(ctx.timezone))
  if (weekdayNumber(wd[2] ?? '') !== now.weekday) return null
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  return names[now.weekday] ?? null
}

/**
 * A tapped answer to a date clarifying question ("Today", "Next Thursday"): the day it names,
 * against the capture context, keeping the time of day `current` already had (in the capture's
 * zone) when the option names only a day. Null when the option names no date.
 */
export function resolveDateAnswer(
  option: string,
  current: number | null,
  ctx: CaptureContext,
): number | null {
  const when = resolveWhen(option, ctx, 'future')
  if (!when) return null
  if (when.hasTime || current === null) return when.at
  const timezone = safeTimezone(ctx.timezone)
  const day = zonedParts(when.at, timezone)
  const time = zonedParts(current, timezone)
  return zonedToEpoch(
    { year: day.year, month: day.month, day: day.day, hour: time.hour, minute: time.minute },
    timezone,
  )
}
