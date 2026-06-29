/**
 * View-model derivation — turns raw entities and suggestions into the small display shapes the
 * Margin Notebook screens render (glyph, label, detail, margin labels, provenance grouping).
 *
 * This is presentation logic only: the server owns all domain rules (the apply/commit engine,
 * create-vs-append, reconciliation). Here we just shape already-validated, read-only data.
 */

import { GLYPH, KIND_LABEL, type Tag, tagForRow } from '@/lib/design'
import type { Activity, Suggestion, Task, Tracker, TrackerEntry } from '@/lib/types'

export type EntityKind = 'task' | 'activity' | 'tracker' | 'tracker_entry'

/** A uniform shape every extracted entity collapses into for stream margins & timeline chips. */
export interface NormalizedEntity {
  kind: EntityKind
  id: string
  sourceBulletId: string | null
  glyph: string
  glyphColorClass: string
  /** Display name — task title, activity/tracker name. */
  label: string
  /** Secondary detail — "4 km · 28 min", "5h", "done", or "". */
  detail: string
  /** Best timestamp for ordering (occurred/logged/due/created). */
  at: number
}

// --- value formatting -----------------------------------------------------------------------

const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const asNumber = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

/** Format a tracker-entry value (number | string | boolean | string[]). */
export function formatValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (Array.isArray(value)) return value.join(', ')
  if (value === null || value === undefined) return ''
  return String(value)
}

function trackerEntryDetail(entry: TrackerEntry, tracker?: Tracker): string {
  const base = formatValue(entry.value)
  // `config` is a discriminated union on `input_type`; narrow on the discriminant (no cast).
  const unit = tracker?.config.input_type === 'number' ? tracker.config.unit : undefined
  return unit ? `${base} ${unit}` : base
}

function activityDetail(a: Activity): string {
  if (a.quantity != null) return a.unit ? `${a.quantity} ${a.unit}` : String(a.quantity)
  return a.notes ?? ''
}

function taskDetail(t: Task): string {
  if (t.status === 'done') return 'done'
  if (t.status === 'migrated') return 'migrated'
  return ''
}

// --- normalization --------------------------------------------------------------------------

export function normalizeTask(t: Task): NormalizedEntity {
  const glyph =
    t.status === 'done' ? GLYPH.done : t.status === 'migrated' ? GLYPH.migrated : GLYPH.task
  return {
    kind: 'task',
    id: t.id,
    sourceBulletId: t.source_bullet_id,
    glyph,
    glyphColorClass: t.status === 'done' ? 'text-sage' : 'text-indigo',
    label: t.title,
    detail: taskDetail(t),
    at: t.due_at ?? t.created_at,
  }
}

export function normalizeActivity(a: Activity): NormalizedEntity {
  return {
    kind: 'activity',
    id: a.id,
    sourceBulletId: a.source_bullet_id,
    glyph: GLYPH.activity,
    glyphColorClass: 'text-indigo',
    label: a.name,
    detail: activityDetail(a),
    at: a.occurred_at,
  }
}

export function normalizeTrackerEntry(
  e: TrackerEntry,
  trackersById: Map<string, Tracker>,
): NormalizedEntity {
  const tracker = trackersById.get(e.tracker_id)
  return {
    kind: 'tracker_entry',
    id: e.id,
    sourceBulletId: e.source_bullet_id,
    glyph: GLYPH.tracker,
    glyphColorClass: 'text-ochre',
    label: tracker?.name ?? 'Tracker',
    detail: trackerEntryDetail(e, tracker),
    at: e.logged_at,
  }
}

/** Compose a one-line margin label: "— sleep · 5h", "○ run · 4 km". */
export function marginLabel(e: NormalizedEntity): string {
  const name = e.label.toLowerCase()
  return e.detail ? `${e.glyph} ${name} · ${e.detail}` : `${e.glyph} ${name}`
}

/** Pick the representative glyph for a bullet from everything extracted out of it. */
export function bulletGlyph(entities: NormalizedEntity[]): {
  glyph: string
  colorClass: string
} {
  const order: EntityKind[] = ['task', 'activity', 'tracker_entry', 'tracker']
  for (const kind of order) {
    const hit = entities.find((e) => e.kind === kind)
    if (hit) return { glyph: hit.glyph, colorClass: hit.glyphColorClass }
  }
  const first = entities[0]
  if (first) return { glyph: first.glyph, colorClass: first.glyphColorClass }
  return { glyph: GLYPH.processing, colorClass: 'text-faint-4' }
}

// --- suggestions ----------------------------------------------------------------------------

/** The bold label before the em-dash in a review row ("Task", "Tracker", "Activity"). */
export function suggestionLabel(s: Suggestion): string {
  return KIND_LABEL[s.target_kind] ?? 'Item'
}

/** A human summary of what a pending suggestion proposes, read defensively from its payload. */
export function suggestionSummary(s: Suggestion, trackersById: Map<string, Tracker>): string {
  const p = s.payload
  switch (s.target_kind) {
    case 'task':
      return asString(p.title) ?? 'New task'
    case 'tracker':
      return asString(p.name) ?? 'New tracker'
    case 'activity': {
      const name = asString(p.name) ?? 'Activity'
      const qty = asNumber(p.quantity)
      const unit = asString(p.unit)
      if (qty != null) return unit ? `${name} · ${qty} ${unit}` : `${name} · ${qty}`
      return name
    }
    case 'tracker_entry': {
      const trackerId = asString(p.tracker_id)
      const tracker = trackerId ? trackersById.get(trackerId) : undefined
      const name = tracker?.name ?? 'Tracker'
      return `${name} · ${formatValue(p.value)}`
    }
    default:
      return 'Suggestion'
  }
}

export interface SuggestionRow {
  id: string
  sourceBulletId: string
  glyph: string
  label: string
  summary: string
  tier: Suggestion['tier']
  targetKind: Suggestion['target_kind']
  /** Locally staged (checkbox ticked) — not yet accepted. */
  staged: boolean
  tag: Tag
}

export function suggestionRow(
  s: Suggestion,
  trackersById: Map<string, Tracker>,
  staged: boolean,
): SuggestionRow {
  return {
    id: s.id,
    sourceBulletId: s.source_bullet_id,
    glyph: GLYPH[s.target_kind] ?? GLYPH.note,
    label: suggestionLabel(s),
    summary: suggestionSummary(s, trackersById),
    tier: s.tier,
    targetKind: s.target_kind,
    staged,
    tag: tagForRow({ tier: s.tier, staged }),
  }
}

// --- grouping -------------------------------------------------------------------------------

export function indexBy<T, K>(items: T[], key: (item: T) => K): Map<K, T> {
  const m = new Map<K, T>()
  for (const it of items) m.set(key(it), it)
  return m
}

export function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>()
  for (const it of items) {
    const k = key(it)
    const arr = m.get(k)
    if (arr) arr.push(it)
    else m.set(k, [it])
  }
  return m
}
