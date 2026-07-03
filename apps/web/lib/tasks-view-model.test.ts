/**
 * Unit tests for the Tasks-page view-model — enrichment, status grouping, header counts, and the
 * form's chip helpers. Pure functions over `@/lib/types` fixtures; no server, no DB. These lock the
 * display + interaction contract the Tasks screen depends on (glyphs, overdue, migrated, manual).
 */

import { describe, expect, test } from 'vitest'
import {
  canSubmitTask,
  doneTaskCount,
  dueChipTargets,
  dueDisplay,
  EMPTY_TASK_FORM,
  enrichTask,
  groupTasks,
  matchDueChip,
  openTaskCount,
  PRIORITY_CHIPS,
  STATUS_CHIPS,
  taskFormValues,
} from '@/lib/tasks-view-model'
import type { Task } from '@/lib/types'

const OWNER = '00000000-0000-4000-8000-00000000aaaa'
const BULLET = '00000000-0000-4000-8000-00000000bbbb'
const DAY = 86_400_000
// A fixed "now" so the relative-date branches are deterministic.
const NOW = new Date(2026, 5, 30, 12, 0, 0).getTime() // Tue 30 Jun 2026, noon

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    owner_id: OWNER,
    created_at: 1000,
    updated_at: 1000,
    state: 'active',
    source_bullet_id: BULLET,
    status: 'todo',
    title: 'Call the dentist',
    notes: null,
    due_at: null,
    priority: null,
    ...overrides,
  }
}

// --- enrichTask -----------------------------------------------------------------------------

describe('enrichTask', () => {
  test('a todo task → • indigo glyph, not struck, extracted, complete/migrate offered', () => {
    const e = enrichTask(makeTask(), NOW)
    expect(e.glyph).toBe('•')
    expect(e.glyphClass).toBe('text-indigo')
    expect(e.strike).toBe(false)
    expect(e.titleClass).toBe('text-ink')
    expect(e.isManual).toBe(false)
    expect(e.extracted).toBe(true)
    expect(e.showComplete).toBe(true)
    expect(e.showMigrate).toBe(true)
    expect(e.showReopen).toBe(false)
  })

  test('in_progress → "/" glyph, still migratable', () => {
    const e = enrichTask(makeTask({ status: 'in_progress' }), NOW)
    expect(e.glyph).toBe('/')
    expect(e.showMigrate).toBe(true)
    expect(e.showComplete).toBe(true)
  })

  test('a done task → ✓ sage glyph, struck + muted, reopen offered, not migratable', () => {
    const e = enrichTask(makeTask({ status: 'done' }), NOW)
    expect(e.glyph).toBe('✓')
    expect(e.glyphClass).toBe('text-sage')
    expect(e.strike).toBe(true)
    expect(e.titleClass).toBe('text-faint-2')
    expect(e.showComplete).toBe(false)
    expect(e.showMigrate).toBe(false)
    expect(e.showReopen).toBe(true)
  })

  test('a migrated task → › glyph, flagged migrated', () => {
    const e = enrichTask(makeTask({ status: 'migrated' }), NOW)
    expect(e.glyph).toBe('›')
    expect(e.isMigrated).toBe(true)
    expect(e.showMigrate).toBe(false)
  })

  test('a cancelled task → ✕ glyph, struck, reopen offered', () => {
    const e = enrichTask(makeTask({ status: 'cancelled' }), NOW)
    expect(e.glyph).toBe('✕')
    expect(e.strike).toBe(true)
    expect(e.showComplete).toBe(false)
    expect(e.showReopen).toBe(true)
  })

  test('a manually-created task (no source bullet) is flagged manual', () => {
    const e = enrichTask(makeTask({ source_bullet_id: null }), NOW)
    expect(e.isManual).toBe(true)
    expect(e.extracted).toBe(false)
  })

  test('provenance row shows for an extracted task, or a manual task with notes', () => {
    expect(enrichTask(makeTask({ source_bullet_id: BULLET, notes: null }), NOW).showProvRow).toBe(
      true,
    )
    expect(
      enrichTask(makeTask({ source_bullet_id: null, notes: 'buy milk' }), NOW).showProvRow,
    ).toBe(true)
    expect(enrichTask(makeTask({ source_bullet_id: null, notes: null }), NOW).showProvRow).toBe(
      false,
    )
    expect(enrichTask(makeTask({ source_bullet_id: null, notes: '   ' }), NOW).hasNotes).toBe(false)
  })

  test('priority maps to its pill classes; none → no pill', () => {
    expect(enrichTask(makeTask({ priority: 'P1' }), NOW).priority).toEqual({
      label: 'P1',
      textClass: 'text-prio-1',
      bgClass: 'bg-prio-1-wash',
    })
    expect(enrichTask(makeTask({ priority: null }), NOW).priority).toBeNull()
  })
})

// --- dueDisplay -----------------------------------------------------------------------------

describe('dueDisplay', () => {
  test('no due date → null', () => {
    expect(dueDisplay(makeTask({ due_at: null }), NOW)).toBeNull()
  })

  test('a future due date on an open task → "due …" in faint, not overdue', () => {
    const d = dueDisplay(makeTask({ due_at: NOW + DAY }), NOW)
    expect(d?.overdue).toBe(false)
    expect(d?.className).toBe('text-faint')
    expect(d?.label).toBe('due Tomorrow')
  })

  test('a past due date on an open task → "overdue · N days ago" in rust', () => {
    expect(dueDisplay(makeTask({ due_at: NOW - DAY }), NOW)).toEqual({
      label: 'overdue · 1 day ago',
      className: 'text-rust',
      overdue: true,
    })
    expect(dueDisplay(makeTask({ due_at: NOW - 2 * DAY }), NOW)?.label).toBe('overdue · 2 days ago')
  })

  test('a resolved (done) task is never "overdue", even with a past due date', () => {
    const d = dueDisplay(makeTask({ status: 'done', due_at: NOW - 2 * DAY }), NOW)
    expect(d?.overdue).toBe(false)
    expect(d?.className).toBe('text-faint')
  })
})

// --- grouping + counts ----------------------------------------------------------------------

describe('groupTasks + counts', () => {
  const tasks = [
    makeTask({ id: 'a', status: 'done' }),
    makeTask({ id: 'b', status: 'todo' }),
    makeTask({ id: 'c', status: 'migrated' }),
    makeTask({ id: 'd', status: 'todo' }),
    makeTask({ id: 'e', status: 'in_progress' }),
  ]

  test('groups appear in reading order, only when non-empty, with correct counts', () => {
    const groups = groupTasks(tasks, NOW)
    expect(groups.map((g) => g.status)).toEqual(['todo', 'in_progress', 'migrated', 'done'])
    expect(groups.find((g) => g.status === 'todo')?.count).toBe(2)
    expect(groups.find((g) => g.status === 'done')?.tasks[0]?.glyph).toBe('✓')
  })

  test('open count = todo + in_progress + migrated; done count = done', () => {
    expect(openTaskCount(tasks)).toBe(4)
    expect(doneTaskCount(tasks)).toBe(1)
  })
})

// --- form helpers ---------------------------------------------------------------------------

describe('task form helpers', () => {
  test('canSubmitTask requires a non-blank title', () => {
    expect(canSubmitTask({ ...EMPTY_TASK_FORM, title: '' })).toBe(false)
    expect(canSubmitTask({ ...EMPTY_TASK_FORM, title: '   ' })).toBe(false)
    expect(canSubmitTask({ ...EMPTY_TASK_FORM, title: 'Do it' })).toBe(true)
  })

  test('taskFormValues pre-fills from a task; empty form starts at todo', () => {
    const t = makeTask({
      title: 'Pay rent',
      status: 'in_progress',
      due_at: 123,
      priority: 'P2',
      notes: 'via app',
    })
    expect(taskFormValues(t)).toEqual({
      title: 'Pay rent',
      status: 'in_progress',
      due_at: 123,
      priority: 'P2',
      notes: 'via app',
    })
    expect(taskFormValues(makeTask({ notes: null })).notes).toBe('')
    expect(EMPTY_TASK_FORM.status).toBe('todo')
  })

  test('status + priority chip sets are complete and ordered', () => {
    expect(STATUS_CHIPS.map((c) => c.value)).toEqual([
      'todo',
      'in_progress',
      'done',
      'migrated',
      'cancelled',
    ])
    expect(PRIORITY_CHIPS.map((c) => c.value)).toEqual(['P1', 'P2', 'P3', 'P4'])
  })
})

// --- due chips ------------------------------------------------------------------------------

describe('due chips', () => {
  test('targets resolve to epoch-ms end-of-day (None is null); labels are stable', () => {
    const chips = dueChipTargets(NOW)
    expect(chips.map((c) => c.label)).toEqual(['Today', 'Tomorrow', 'This week', 'None'])
    expect(chips[0]?.ms).toBeTypeOf('number')
    expect(chips.find((c) => c.key === 'none')?.ms).toBeNull()
    // "This week" resolves to a Friday.
    const weekMs = chips.find((c) => c.key === 'week')?.ms as number
    expect(new Date(weekMs).getDay()).toBe(5)
  })

  test('matchDueChip highlights the matching preset; null → None; arbitrary → nothing', () => {
    const today = dueChipTargets(NOW).find((c) => c.key === 'today')?.ms as number
    expect(matchDueChip(today, NOW)).toBe('today')
    expect(matchDueChip(null, NOW)).toBe('none')
    // A date far in the past matches none of the presets.
    expect(matchDueChip(NOW - 40 * DAY, NOW)).toBeNull()
  })
})
