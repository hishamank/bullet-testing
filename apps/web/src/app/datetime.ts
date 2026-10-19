/**
 * `<input type="datetime-local">` values, pure. The field holds a wall-clock time without a zone;
 * the browser's own zone is the one the user is in, so it converts both ways with `Date`.
 */

const pad = (n: number) => String(n).padStart(2, '0')

/** Epoch ms → "2026-10-15T09:12" in the browser's zone. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** "2026-10-15T09:12" → epoch ms, or null when the field is empty or not a date. */
export function fromLocalInput(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!m) return null
  const [, y, mo, d, h, mi] = m.map(Number) as [number, number, number, number, number, number]
  const date = new Date(y, mo - 1, d, h, mi)
  // Reject dates JS rolled over (31 February).
  if (date.getMonth() !== mo - 1 || date.getDate() !== d) return null
  return date.getTime()
}
