/**
 * Tasks-page view-model — pure presentation logic for the status-grouped list and the create/edit
 * form. Like `view-model.ts`, this shapes already-validated, read-only data (plus the small form
 * chip configs); the server owns every domain rule (create/append, reconciliation, the tiers).
 *
 * Kept out of the components so the Tasks screen stays declarative and this logic stays testable.
 */

import {
  PRIORITY_META,
  TASK_STATUS_META,
  TASK_STATUS_ORDER,
  type TaskStatusMeta,
} from '@/lib/design'
import { dayKey, daysAgo, dueLabel } from '@/lib/format'
import type { Task, TaskPriority, TaskStatus } from '@/lib/types'

/** Open work (still on your plate) vs. resolved — the split behind the header count + overdue. */
const OPEN_STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'migrated']
const isOpen = (s: TaskStatus) => OPEN_STATUSES.includes(s)

/** A due date resolved for display: the label + the ink class (rust once overdue). */
export interface DueDisplay {
  label: string
  className: string
  overdue: boolean
}

/** One task enriched with everything the row renders — derived purely from the task's own fields. */
export interface EnrichedTask {
  task: Task
  glyph: string
  glyphClass: string
  /** Done / cancelled read as resolved: struck through + muted. */
  strike: boolean
  titleClass: string
  due: DueDisplay | null
  priority: { label: string; textClass: string; bgClass: string } | null
  isMigrated: boolean
  /** True when the task was typed in by hand (no source bullet). */
  isManual: boolean
  /** True when the task traces back to a bullet (has a provenance thread). */
  extracted: boolean
  hasNotes: boolean
  /** Whether there's anything to reveal on expand (a source quote and/or notes). */
  showProvRow: boolean
  showComplete: boolean
  showMigrate: boolean
  showReopen: boolean
}

/** Format a task's `due_at` for the list — "due Fri" normally, "overdue · 2 days ago" when late. */
export function dueDisplay(task: Task, now: number = Date.now()): DueDisplay | null {
  if (task.due_at == null) return null
  const behind = daysAgo(task.due_at, now) // >0 = in the past
  if (isOpen(task.status) && behind > 0) {
    const ago = behind === 1 ? '1 day ago' : `${behind} days ago`
    return { label: `overdue · ${ago}`, className: 'text-rust', overdue: true }
  }
  return { label: `due ${dueLabel(task.due_at, now)}`, className: 'text-faint', overdue: false }
}

export function enrichTask(task: Task, now: number = Date.now()): EnrichedTask {
  const meta = TASK_STATUS_META[task.status]
  const strike = task.status === 'done' || task.status === 'cancelled'
  const hasNotes = !!task.notes?.trim()
  const extracted = task.source_bullet_id != null
  const priority = task.priority ? { label: task.priority, ...PRIORITY_META[task.priority] } : null
  return {
    task,
    glyph: meta.glyph,
    glyphClass: meta.glyphClass,
    strike,
    titleClass: strike ? 'text-faint-2' : 'text-ink',
    due: dueDisplay(task, now),
    priority,
    isMigrated: task.status === 'migrated',
    isManual: !extracted,
    extracted,
    hasNotes,
    showProvRow: extracted || hasNotes,
    showComplete: task.status !== 'done' && task.status !== 'cancelled',
    showMigrate: task.status === 'todo' || task.status === 'in_progress',
    showReopen: task.status === 'done' || task.status === 'cancelled',
  }
}

/** A status group in the list — heading + the enriched tasks under it (only non-empty groups). */
export interface TaskGroup {
  status: TaskStatus
  meta: TaskStatusMeta
  count: number
  tasks: EnrichedTask[]
}

/** Group active tasks by status in reading order, enriching each; empty groups are dropped. */
export function groupTasks(tasks: Task[], now: number = Date.now()): TaskGroup[] {
  return TASK_STATUS_ORDER.map((status) => {
    const inGroup = tasks.filter((t) => t.status === status)
    return {
      status,
      meta: TASK_STATUS_META[status],
      count: inGroup.length,
      tasks: inGroup.map((t) => enrichTask(t, now)),
    }
  }).filter((g) => g.count > 0)
}

/** Count still-open tasks (todo / in progress / migrated) for the header. */
export function openTaskCount(tasks: Task[]): number {
  return tasks.filter((t) => isOpen(t.status)).length
}

/** Count completed tasks for the header. */
export function doneTaskCount(tasks: Task[]): number {
  return tasks.filter((t) => t.status === 'done').length
}

// --- the create / edit form -----------------------------------------------------------------

/** The editable shape the task form drives — mirrors the schema's client-writable fields. */
export interface TaskFormValues {
  title: string
  status: TaskStatus
  due_at: number | null
  priority: TaskPriority | null
  notes: string
}

/** A fresh, empty form (create) — status starts at the natural `todo`. */
export const EMPTY_TASK_FORM: TaskFormValues = {
  title: '',
  status: 'todo',
  due_at: null,
  priority: null,
  notes: '',
}

/** Pre-fill the form from an existing task (edit-in-place). */
export function taskFormValues(task: Task): TaskFormValues {
  return {
    title: task.title,
    status: task.status,
    due_at: task.due_at,
    priority: task.priority,
    notes: task.notes ?? '',
  }
}

/** A title with content is the only requirement to create or save. */
export function canSubmitTask(values: TaskFormValues): boolean {
  return values.title.trim().length > 0
}

/** The status chips, in the form's order (To do · In progress · Done · Migrated · Cancelled). */
export const STATUS_CHIP_ORDER: TaskStatus[] = [
  'todo',
  'in_progress',
  'done',
  'migrated',
  'cancelled',
]

export interface StatusChip {
  value: TaskStatus
  label: string
  glyph: string
  glyphClass: string
}

export const STATUS_CHIPS: StatusChip[] = STATUS_CHIP_ORDER.map((value) => ({
  value,
  label: TASK_STATUS_META[value].label,
  glyph: TASK_STATUS_META[value].glyph,
  glyphClass: TASK_STATUS_META[value].glyphClass,
}))

export const PRIORITY_CHIPS: { value: TaskPriority; label: string }[] = (
  ['P1', 'P2', 'P3', 'P4'] as const
).map((value) => ({ value, label: value }))

/** A quick-set due chip — a relative label resolved to an epoch-ms target (or null for "None"). */
export interface DueChip {
  key: string
  label: string
  ms: number | null
}

const endOfDay = (d: Date): number => {
  d.setHours(23, 59, 0, 0)
  return d.getTime()
}

/**
 * The form's relative due presets. No natural-language date parsing (out of scope) — just a few
 * honest quick-sets. "This week" resolves to the coming Friday, matching Review's third preset.
 */
export function dueChipTargets(now: number = Date.now()): DueChip[] {
  const today = new Date(now)
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const friday = new Date(now)
  const delta = (5 - friday.getDay() + 7) % 7 // 5 = Friday; 0 → the coming Friday, not today
  friday.setDate(friday.getDate() + (delta === 0 ? 7 : delta))
  return [
    { key: 'today', label: 'Today', ms: endOfDay(today) },
    { key: 'tomorrow', label: 'Tomorrow', ms: endOfDay(tomorrow) },
    { key: 'week', label: 'This week', ms: endOfDay(friday) },
    { key: 'none', label: 'None', ms: null },
  ]
}

/**
 * Which due chip (if any) a stored `due_at` currently matches — so editing highlights the right
 * preset. An arbitrary date that matches none simply leaves them unselected (the value is kept).
 */
export function matchDueChip(dueAt: number | null, now: number = Date.now()): string | null {
  if (dueAt == null) return 'none'
  const target = dayKey(dueAt)
  const hit = dueChipTargets(now).find((c) => c.ms != null && dayKey(c.ms) === target)
  return hit ? hit.key : null
}
