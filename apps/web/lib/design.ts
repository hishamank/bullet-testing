/**
 * Margin Notebook design primitives — the small, pure mapping helpers shared by every screen.
 *
 * Rapid-logging glyphs: • task · ○ activity · — note/tracker. Migrated tasks carry ›, done ✓.
 * Behavior tiers surface as words, never numbers (CLAUDE.md §4.5): a confirmed row reads
 * "applied", a staged one "will apply", an `ask` one "your call", a plain suggestion "suggested".
 */

import type { SuggestionTier, TargetKind, TaskPriority, TaskStatus } from '@/lib/types'

/** The four base kinds the agent extracts, plus the glyphs the journal hangs in the margin. */
export const GLYPH = {
  task: '•',
  activity: '○',
  tracker: '—',
  tracker_entry: '—',
  note: '—',
  migrated: '›',
  done: '✓',
  processing: '·',
  error: '!',
} as const

/** Human label shown before the em-dash in a review/overview row. */
export const KIND_LABEL: Record<TargetKind, string> = {
  task: 'Task',
  tracker: 'Tracker',
  tracker_entry: 'Tracker',
  activity: 'Activity',
}

export interface Tag {
  text: string
  /** Tailwind text-color class. */
  className: string
}

/**
 * Map a pending suggestion's tier + staged state to its margin tag. Auto-tier rows never reach
 * the review surface (they self-apply), so only `suggest` / `ask` / staged appear here.
 */
export function tagForRow(opts: { tier: SuggestionTier; staged: boolean }): Tag {
  if (opts.staged) return { text: 'will apply', className: 'text-indigo' }
  if (opts.tier === 'ask') return { text: 'your call', className: 'text-ochre' }
  return { text: 'suggested', className: 'text-faint' }
}

/** Task status → the small uppercase status pill used in Overview. */
export function statusPill(status: TaskStatus): {
  text: string
  textClass: string
  bgClass: string
} {
  switch (status) {
    case 'done':
      return { text: 'Done', textClass: 'text-sage', bgClass: 'bg-sage-wash' }
    case 'in_progress':
      return { text: 'In progress', textClass: 'text-indigo', bgClass: 'bg-indigo-wash' }
    case 'migrated':
      return { text: 'Migrated', textClass: 'text-indigo', bgClass: 'bg-indigo-wash' }
    case 'cancelled':
      return { text: 'Cancelled', textClass: 'text-faint', bgClass: 'bg-line-soft' }
    default:
      return { text: 'To do', textClass: 'text-ochre', bgClass: 'bg-line-soft' }
  }
}

/** The glyph shown for a task in lists, accounting for done / migrated states. */
export function taskGlyph(status: TaskStatus): { glyph: string; colorClass: string } {
  if (status === 'done') return { glyph: GLYPH.done, colorClass: 'text-sage' }
  if (status === 'migrated') return { glyph: GLYPH.migrated, colorClass: 'text-indigo' }
  return { glyph: GLYPH.task, colorClass: 'text-indigo' }
}

/**
 * Per-status metadata for the Tasks page: the group heading label, the rapid-logging glyph, and
 * the ink/wash Tailwind classes. This is the fuller vocabulary the standalone Tasks manager needs
 * (`in_progress` → `/`, `cancelled` → `✕`) — Overview keeps the leaner `taskGlyph` / `statusPill`.
 */
export interface TaskStatusMeta {
  label: string
  glyph: string
  /** Tailwind text-color class for the glyph. */
  glyphClass: string
}

export const TASK_STATUS_META: Record<TaskStatus, TaskStatusMeta> = {
  todo: { label: 'To do', glyph: '•', glyphClass: 'text-indigo' },
  in_progress: { label: 'In progress', glyph: '/', glyphClass: 'text-indigo' },
  migrated: { label: 'Migrated', glyph: '›', glyphClass: 'text-indigo' },
  done: { label: 'Done', glyph: '✓', glyphClass: 'text-sage' },
  cancelled: { label: 'Cancelled', glyph: '✕', glyphClass: 'text-faint-3' },
}

/** Fixed reading order for the status groups — open work first, resolved work last. */
export const TASK_STATUS_ORDER: TaskStatus[] = [
  'todo',
  'in_progress',
  'migrated',
  'done',
  'cancelled',
]

/** A task priority's small pill — ink + wash Tailwind classes (P1 urgent → P4 faint). */
export const PRIORITY_META: Record<TaskPriority, { textClass: string; bgClass: string }> = {
  P1: { textClass: 'text-prio-1', bgClass: 'bg-prio-1-wash' },
  P2: { textClass: 'text-prio-2', bgClass: 'bg-prio-2-wash' },
  P3: { textClass: 'text-prio-3', bgClass: 'bg-prio-3-wash' },
  P4: { textClass: 'text-prio-4', bgClass: 'bg-prio-4-wash' },
}
