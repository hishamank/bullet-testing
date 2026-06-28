/**
 * Date / time formatting. All domain timestamps are epoch-ms integers (CLAUDE.md "Timestamps —
 * CANONICAL"). These helpers run client-side only (every screen is a client component), so using
 * the local timezone for grouping and display is correct.
 */

const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_SHORT = [
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
const MONTH_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

const pad = (n: number) => (n < 10 ? `0${n}` : String(n))

/** "08:51" — 24-hour clock. */
export function formatTime(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Local calendar-day key, e.g. "2026-06-28" — used to group entries by day. */
export function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Whole-day distance from `now` (0 = today, 1 = yesterday, …), local time. */
export function daysAgo(ms: number, now: number = Date.now()): number {
  const a = new Date(ms)
  const b = new Date(now)
  const da = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime()
  const db = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime()
  return Math.round((db - da) / 86_400_000)
}

/** The big day name in the Timeline ("Tuesday", "Today", "Yesterday"). */
export function dayName(ms: number, now: number = Date.now()): string {
  const diff = daysAgo(ms, now)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  return WEEKDAY_LONG[new Date(ms).getDay()] ?? ''
}

/** The small relative badge shown next to the day name ("Today"/"Yesterday"), else "". */
export function relBadge(ms: number, now: number = Date.now()): string {
  const diff = daysAgo(ms, now)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  return ''
}

/** "22 June" — day + long month. */
export function dayDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getDate()} ${MONTH_LONG[d.getMonth()]}`
}

/** "Mon" / "Today" / "Yesterday" — compact day label for review groups & lists. */
export function shortDay(ms: number, now: number = Date.now()): string {
  const diff = daysAgo(ms, now)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  return WEEKDAY_SHORT[new Date(ms).getDay()] ?? ''
}

// TODO(review): a past-due date renders as a bare "Jun 25" with no overdue affordance. Minor UX
// follow-up — surface overdue-ness (label/colour) at the call sites. — see REVIEW-BACKLOG.md
/** A due-date chip label: "Today" / "Tomorrow" / weekday within a week / "Jun 28". */
export function dueLabel(ms: number, now: number = Date.now()): string {
  const diff = daysAgo(ms, now) // negative = future
  if (diff === 0) return 'Today'
  if (diff === -1) return 'Tomorrow'
  if (diff < 0 && diff > -7) return WEEKDAY_SHORT[new Date(ms).getDay()] ?? ''
  const d = new Date(ms)
  return `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`
}

/** Time-of-day greeting. */
export function greeting(now: number = Date.now()): string {
  const h = new Date(now).getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

/** "Tuesday · 22 June" — the overview eyebrow. */
export function fullDateLine(now: number = Date.now()): string {
  const d = new Date(now)
  return `${WEEKDAY_LONG[d.getDay()]} · ${d.getDate()} ${MONTH_LONG[d.getMonth()]}`
}
