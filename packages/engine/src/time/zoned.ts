/**
 * Time-zone arithmetic on epoch milliseconds using only `Intl` (no date library), so it runs on
 * the server, the phone (Hermes) and the web alike.
 */

/** A wall-clock reading in some zone. `month` is 1-12, `weekday` 0 = Sunday … 6 = Saturday. */
export interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  weekday: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** A zone the runtime knows, or 'UTC' when it doesn't (never throws on a bad zone). */
export function safeTimezone(timezone: string): string {
  if (formatters.has(timezone)) return timezone
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    return timezone
  } catch {
    return 'UTC'
  }
}

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    })
    formatters.set(timezone, f)
  }
  return f
}

/** The wall-clock reading of `epochMs` in `timezone`. */
export function zonedParts(epochMs: number, timezone: string): ZonedParts {
  const parts = formatterFor(safeTimezone(timezone)).formatToParts(new Date(epochMs))
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '0'
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    weekday: WEEKDAYS[get('weekday')] ?? 0,
  }
}

/** The zone's offset from UTC at `epochMs`, in ms (positive east of Greenwich). */
function offsetAt(epochMs: number, timezone: string): number {
  const p = zonedParts(epochMs, timezone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
  return asUtc - (epochMs - (epochMs % 60_000))
}

/**
 * The epoch ms of a local wall-clock time in `timezone`. Out-of-range fields roll over like
 * `Date.UTC` (day 32 → next month). A wall time that does not exist or exists twice (DST
 * transitions) resolves to a valid instant within an hour of it.
 */
export function zonedToEpoch(
  local: { year: number; month: number; day: number; hour?: number; minute?: number },
  timezone: string,
): number {
  const tz = safeTimezone(timezone)
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour ?? 0, local.minute ?? 0)
  const first = asUtc - offsetAt(asUtc, tz)
  const second = asUtc - offsetAt(first, tz)
  return Math.min(first, second)
}

/** Add whole days to a local calendar date (pure calendar math, no zone involved). */
export function addDays(
  date: { year: number; month: number; day: number },
  days: number,
): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days))
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

/** Format a wall-clock reading for prompts: "Thursday 2026-10-15 09:05". */
export function formatZoned(p: ZonedParts): string {
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${names[p.weekday]} ${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`
}
