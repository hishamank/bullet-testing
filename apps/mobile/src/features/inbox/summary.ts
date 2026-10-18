/**
 * Readable one-line summaries of suggestions ("Dentist · Thu 15:00", "Mood · 3 / 5") and the
 * matching VoiceOver phrases. Pure: the clock and the time zone come in as arguments.
 */

import type {
  SuggestionOperation,
  SuggestionPayload,
  TargetKind,
  ThoughtKind,
  TrackerConfig,
  TrackerEntryValue,
} from '@bullet/core'
import { zonedParts } from '@bullet/engine'

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
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

export interface WhenText {
  /** What the row shows: "Thu 15:00", "Today 09:30", "Thu 23 Oct". */
  text: string
  /** What VoiceOver says: "Thursday 15:00". */
  spoken: string
}

/** Whole calendar days from `now` to `at`, both read in `timezone`. */
function dayDelta(at: number, now: number, timezone: string): number {
  const a = zonedParts(at, timezone)
  const b = zonedParts(now, timezone)
  return Math.round(
    (Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day)) / 86_400_000,
  )
}

/**
 * A date the way the Inbox shows it: today/tomorrow by name, the coming week by weekday
 * ("Thu 15:00"), anything further with its date ("Thu 23 Oct 15:00"). `allDay` drops the time.
 */
export function formatWhen(at: number, now: number, timezone: string, allDay = false): WhenText {
  const p = zonedParts(at, timezone)
  const pad = (n: number) => String(n).padStart(2, '0')
  const time = allDay ? '' : ` ${pad(p.hour)}:${pad(p.minute)}`
  const delta = dayDelta(at, now, timezone)
  const sameYear = p.year === zonedParts(now, timezone).year
  let text: string
  let spoken: string
  if (delta === 0) {
    text = spoken = 'Today'
  } else if (delta === 1) {
    text = spoken = 'Tomorrow'
  } else if (delta === -1) {
    text = spoken = 'Yesterday'
  } else if (delta > 1 && delta < 7) {
    text = DAY_SHORT[p.weekday] ?? ''
    spoken = DAY_LONG[p.weekday] ?? ''
  } else {
    const year = sameYear ? '' : ` ${p.year}`
    text = `${DAY_SHORT[p.weekday]} ${p.day} ${MONTH_SHORT[p.month - 1]}${year}`
    spoken = `${DAY_LONG[p.weekday]} ${p.day} ${MONTH_LONG[p.month - 1]}${year}`
  }
  return { text: text + time, spoken: spoken + time }
}

/** A tracker reading's value: "3 / 5", "72 kg", "Yes", "tea, coffee". */
export function formatValue(value: TrackerEntryValue, config?: TrackerConfig | null): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'number') {
    if (config?.input_type === 'scale') return `${value} / ${config.max}`
    if (config?.input_type === 'number' && config.unit) return `${value} ${config.unit}`
  }
  return String(value)
}

const INPUT_TYPE_LABELS: Record<TrackerConfig['input_type'], string> = {
  scale: 'scale',
  number: 'number',
  single_select: 'one of a list',
  multi_select: 'several of a list',
  boolean: 'yes / no',
  text: 'text',
}

/** "number · glasses", "scale · 1–5". */
function trackerShape(config: TrackerConfig | undefined): string | null {
  if (!config) return null
  const parts = [INPUT_TYPE_LABELS[config.input_type]]
  if (config.input_type === 'scale') parts.push(`${config.min}–${config.max}`)
  if (config.input_type === 'number' && config.unit) parts.push(config.unit)
  return parts.join(' · ')
}

/** What a summary needs to know about the world around the suggestion. */
export interface SummaryContext {
  now: number
  timezone: string
  /** Trackers by id (existing ones, and ones pending creation), for names and scales. */
  trackers: ReadonlyMap<string, { name: string; config: TrackerConfig }>
  /** Titles of existing tasks/events by id, for `update` suggestions. */
  titles: ReadonlyMap<string, string>
}

export interface SuggestionLike {
  target_kind: TargetKind
  operation: SuggestionOperation
  target_id: string | null
  payload: SuggestionPayload
}

export interface Summary {
  /** The pill: a thought kind for its colours, and the word shown on it. */
  pill: { kind: ThoughtKind; label: string }
  /** The row text. */
  text: string
  /** The row for VoiceOver ("Dentist, Thursday 15:00"). */
  spoken: string
  /** Short name used in notices ("Dentist"). */
  name: string
  /** The past-tense line under Done for you ("Run · 5 km logged"). */
  done: string
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function join(parts: (string | null | undefined)[], sep: string): string {
  return parts.filter((p): p is string => !!p).join(sep)
}

export function summarize(s: SuggestionLike, ctx: SummaryContext): Summary {
  const p = s.payload
  const when = (at: number | null, allDay = false) =>
    at === null ? null : formatWhen(at, ctx.now, ctx.timezone, allDay)

  switch (s.target_kind) {
    case 'event': {
      if (s.operation === 'update') return updateSummary(s, ctx, 'event')
      const name = str(p.title) ?? 'Event'
      const w = when(num(p.starts_at), p.all_day === true)
      return {
        pill: { kind: 'event', label: 'event' },
        text: join([name, w?.text], ' · '),
        spoken: join([name, w?.spoken], ', '),
        name,
        done: `${join([name, w?.text], ' · ')} added`,
      }
    }
    case 'task': {
      if (s.operation === 'update') return updateSummary(s, ctx, 'task')
      const name = str(p.title) ?? 'Task'
      const w = when(num(p.due_at))
      return {
        pill: { kind: 'task', label: 'task' },
        text: join([name, w ? `due ${w.text}` : null], ' · '),
        spoken: join([name, w ? `due ${w.spoken}` : null], ', '),
        name,
        done: `${name} added to your tasks`,
      }
    }
    case 'tracker': {
      const name = str(p.name) ?? 'Tracker'
      const shape = trackerShape(p.config as TrackerConfig | undefined)
      return {
        pill: { kind: 'tracker', label: 'new tracker' },
        text: join([name, shape], ' · '),
        spoken: join([`New tracker ${name}`, shape?.replace(' · ', ', ')], ', '),
        name,
        done: `Started tracking ${name}`,
      }
    }
    case 'tracker_entry': {
      const trackerId = str(p.tracker_id) ?? s.target_id
      const tracker = trackerId ? ctx.trackers.get(trackerId) : undefined
      const name = tracker?.name ?? 'Reading'
      const value = p.value as TrackerEntryValue | undefined
      const shown = value === undefined ? null : formatValue(value, tracker?.config)
      return {
        pill: { kind: 'tracker', label: tracker ? tracker.name.toLowerCase() : 'reading' },
        text: join([name, shown], ' · '),
        spoken: join([name, shown?.replace(' / ', ' out of ')], ', '),
        name,
        done: `${join([name, shown], ' · ')} logged`,
      }
    }
    case 'activity': {
      const name = str(p.name) ?? 'Activity'
      const quantity = num(p.quantity)
      const amount = quantity === null ? null : join([String(quantity), str(p.unit)], ' ')
      return {
        pill: { kind: 'activity', label: 'activity' },
        text: join([name, amount], ' · '),
        spoken: join([name, amount], ', '),
        name,
        done: `${join([name, amount], ' · ')} logged`,
      }
    }
  }
}

/** `update` suggestions: "“Call mom” → done", "“Dentist” → Thu 16:00". */
function updateSummary(s: SuggestionLike, ctx: SummaryContext, kind: 'task' | 'event'): Summary {
  const p = s.payload
  const name = (s.target_id && ctx.titles.get(s.target_id)) || str(p.title) || kind
  const quoted = `“${name}”`
  const changes: { text: string; spoken: string; done: string }[] = []
  if (typeof p.status === 'string') {
    const label = p.status === 'done' ? 'done' : p.status.replace('_', ' ')
    changes.push({ text: `mark ${label}`, spoken: `mark ${label}`, done: `marked ${label}` })
  }
  const at = num(kind === 'task' ? p.due_at : p.starts_at)
  if (at !== null) {
    const w = formatWhen(at, ctx.now, ctx.timezone)
    const verb = kind === 'task' ? 'due' : 'moved to'
    changes.push({
      text: `${verb} ${w.text}`,
      spoken: `${verb} ${w.spoken}`,
      done: `${verb} ${w.text}`,
    })
  }
  if (str(p.title) && p.title !== name) {
    const t = `rename to “${String(p.title)}”`
    changes.push({ text: t, spoken: t, done: `renamed to “${String(p.title)}”` })
  }
  if (changes.length === 0) changes.push({ text: 'update', spoken: 'update', done: 'updated' })
  return {
    pill: { kind, label: kind },
    text: `${quoted} · ${changes.map((c) => c.text).join(', ')}`,
    spoken: `${name}, ${changes.map((c) => c.spoken).join(', ')}`,
    name,
    done: `${quoted} ${changes.map((c) => c.done).join(', ')}`,
  }
}

/** A capture's text as a short quoted snippet for a group header. */
export function snippet(text: string, max = 90): string {
  const one = text.replace(/\s+/g, ' ').trim()
  if (one.length <= max) return `“${one}”`
  const cut = one.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `“${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…”`
}
