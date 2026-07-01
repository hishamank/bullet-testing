/**
 * Unit tests for the web's pure presentation logic (lib/view-model.ts + the design helpers it
 * composes). No server, no DB — just realistic entity fixtures shaped to `@/lib/types` driven
 * through the normalizers, the bullet-glyph picker, the grouping helpers, and the suggestion-row
 * mapping. These lock the display contract the Margin Notebook screens depend on.
 */

import { describe, expect, test } from 'vitest'
import { GLYPH } from '@/lib/design'
import type { Activity, Suggestion, Task, Tracker, TrackerEntry } from '@/lib/types'
import {
  bulletGlyph,
  formatValue,
  groupBy,
  indexBy,
  marginLabel,
  type NormalizedEntity,
  normalizeActivity,
  normalizeTask,
  normalizeTrackerEntry,
  suggestionLabel,
  suggestionRow,
  suggestionSummary,
} from '@/lib/view-model'

// --- fixtures -------------------------------------------------------------------------------

const OWNER = '00000000-0000-4000-8000-00000000aaaa'
const BULLET = '00000000-0000-4000-8000-00000000bbbb'

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

function makeActivity(overrides: Partial<Activity> = {}): Activity {
  return {
    id: 'act-1',
    owner_id: OWNER,
    created_at: 2000,
    updated_at: 2000,
    state: 'active',
    source_bullet_id: BULLET,
    name: 'Run',
    occurred_at: 2500,
    tracker_id: null,
    notes: null,
    quantity: null,
    unit: null,
    ...overrides,
  }
}

function makeTracker(overrides: Partial<Tracker> = {}): Tracker {
  return {
    id: 'trk-1',
    owner_id: OWNER,
    created_at: 3000,
    updated_at: 3000,
    state: 'active',
    source_bullet_id: null,
    name: 'Sleep',
    input_type: 'number',
    config: { input_type: 'number', unit: 'h' },
    ...overrides,
  }
}

function makeTrackerEntry(overrides: Partial<TrackerEntry> = {}): TrackerEntry {
  return {
    id: 'te-1',
    owner_id: OWNER,
    created_at: 4000,
    updated_at: 4000,
    state: 'active',
    source_bullet_id: BULLET,
    tracker_id: 'trk-1',
    value: 5,
    logged_at: 4200,
    ...overrides,
  }
}

function makeSuggestion(overrides: Partial<Suggestion> = {}): Suggestion {
  return {
    id: 'sug-1',
    owner_id: OWNER,
    created_at: 5000,
    updated_at: 5000,
    state: 'active',
    source_bullet_id: BULLET,
    target_kind: 'task',
    operation: 'create',
    target_id: null,
    payload: { title: 'Call the dentist' },
    confidence: 0.9,
    tier: 'suggest',
    status: 'pending',
    resolved_at: null,
    ...overrides,
  }
}

// --- normalizeTask --------------------------------------------------------------------------

describe('normalizeTask', () => {
  test('a todo task → task glyph, indigo, no detail, ordered by created_at when no due', () => {
    const n = normalizeTask(makeTask())
    expect(n.kind).toBe('task')
    expect(n.glyph).toBe(GLYPH.task)
    expect(n.glyphColorClass).toBe('text-indigo')
    expect(n.label).toBe('Call the dentist')
    expect(n.detail).toBe('')
    expect(n.sourceBulletId).toBe(BULLET)
    expect(n.at).toBe(1000)
  })

  test('a done task → done glyph (✓), sage color, "done" detail', () => {
    const n = normalizeTask(makeTask({ status: 'done' }))
    expect(n.glyph).toBe(GLYPH.done)
    expect(n.glyphColorClass).toBe('text-sage')
    expect(n.detail).toBe('done')
  })

  test('a migrated task → migrated glyph (›), still indigo, "migrated" detail', () => {
    const n = normalizeTask(makeTask({ status: 'migrated' }))
    expect(n.glyph).toBe(GLYPH.migrated)
    expect(n.glyphColorClass).toBe('text-indigo')
    expect(n.detail).toBe('migrated')
  })

  test('due_at wins over created_at for ordering', () => {
    const n = normalizeTask(makeTask({ created_at: 1000, due_at: 9999 }))
    expect(n.at).toBe(9999)
  })
})

// --- normalizeActivity ----------------------------------------------------------------------

describe('normalizeActivity', () => {
  test('activity → activity glyph (○), indigo, name label, ordered by occurred_at', () => {
    const n = normalizeActivity(makeActivity())
    expect(n.kind).toBe('activity')
    expect(n.glyph).toBe(GLYPH.activity)
    expect(n.glyphColorClass).toBe('text-indigo')
    expect(n.label).toBe('Run')
    expect(n.at).toBe(2500)
  })

  test('quantity + unit → "4 km" detail', () => {
    const n = normalizeActivity(makeActivity({ quantity: 4, unit: 'km' }))
    expect(n.detail).toBe('4 km')
  })

  test('quantity without unit → bare number detail', () => {
    const n = normalizeActivity(makeActivity({ quantity: 4, unit: null }))
    expect(n.detail).toBe('4')
  })

  test('no quantity → falls back to notes (or empty)', () => {
    expect(normalizeActivity(makeActivity({ notes: 'felt great' })).detail).toBe('felt great')
    expect(normalizeActivity(makeActivity({ notes: null })).detail).toBe('')
  })
})

// --- normalizeTrackerEntry ------------------------------------------------------------------

describe('normalizeTrackerEntry', () => {
  test('entry → tracker glyph (—), ochre, tracker name + unit detail, ordered by logged_at', () => {
    const trackers = new Map<string, Tracker>([['trk-1', makeTracker()]])
    const n = normalizeTrackerEntry(makeTrackerEntry(), trackers)
    expect(n.kind).toBe('tracker_entry')
    expect(n.glyph).toBe(GLYPH.tracker)
    expect(n.glyphColorClass).toBe('text-ochre')
    expect(n.label).toBe('Sleep')
    expect(n.detail).toBe('5 h')
    expect(n.at).toBe(4200)
  })

  test('unknown tracker id → "Tracker" label and unit-less detail', () => {
    const n = normalizeTrackerEntry(makeTrackerEntry({ tracker_id: 'missing' }), new Map())
    expect(n.label).toBe('Tracker')
    expect(n.detail).toBe('5')
  })
})

// --- formatValue ----------------------------------------------------------------------------

describe('formatValue', () => {
  test('booleans render as yes/no', () => {
    expect(formatValue(true)).toBe('yes')
    expect(formatValue(false)).toBe('no')
  })

  test('arrays join with comma-space; nullish is empty; scalars stringify', () => {
    expect(formatValue(['a', 'b'])).toBe('a, b')
    expect(formatValue(null)).toBe('')
    expect(formatValue(undefined)).toBe('')
    expect(formatValue(7)).toBe('7')
    expect(formatValue('hi')).toBe('hi')
  })
})

// --- marginLabel ----------------------------------------------------------------------------

describe('marginLabel', () => {
  const base: NormalizedEntity = {
    kind: 'activity',
    id: 'x',
    sourceBulletId: BULLET,
    glyph: '○',
    glyphColorClass: 'text-indigo',
    label: 'Run',
    detail: '',
    at: 0,
  }

  test('with detail → "glyph name · detail" with a lowercased name', () => {
    expect(marginLabel({ ...base, detail: '4 km' })).toBe('○ run · 4 km')
  })

  test('without detail → just "glyph name"', () => {
    expect(marginLabel(base)).toBe('○ run')
  })
})

// --- bulletGlyph ----------------------------------------------------------------------------

describe('bulletGlyph', () => {
  test('prefers a task over other kinds extracted from the same bullet', () => {
    const entities = [
      normalizeTrackerEntry(makeTrackerEntry(), new Map([['trk-1', makeTracker()]])),
      normalizeActivity(makeActivity()),
      normalizeTask(makeTask()),
    ]
    const g = bulletGlyph(entities)
    expect(g.glyph).toBe(GLYPH.task)
    expect(g.colorClass).toBe('text-indigo')
  })

  test('an activity-only bullet → activity glyph, indigo', () => {
    const g = bulletGlyph([normalizeActivity(makeActivity())])
    expect(g.glyph).toBe(GLYPH.activity)
    expect(g.colorClass).toBe('text-indigo')
  })

  test('a tracker-entry-only bullet → tracker glyph, ochre', () => {
    const g = bulletGlyph([
      normalizeTrackerEntry(makeTrackerEntry(), new Map([['trk-1', makeTracker()]])),
    ])
    expect(g.glyph).toBe(GLYPH.tracker)
    expect(g.colorClass).toBe('text-ochre')
  })

  test('an empty bullet (nothing extracted yet) → processing glyph, faint', () => {
    const g = bulletGlyph([])
    expect(g.glyph).toBe(GLYPH.processing)
    expect(g.colorClass).toBe('text-faint-4')
  })
})

// --- indexBy / groupBy ----------------------------------------------------------------------

describe('indexBy / groupBy', () => {
  test('indexBy keys each item by the selector; last write wins on a duplicate key', () => {
    const idx = indexBy(
      [
        makeTracker({ id: 'a', name: 'first' }),
        makeTracker({ id: 'b' }),
        makeTracker({ id: 'a', name: 'second' }),
      ],
      (t) => t.id,
    )
    expect(idx.size).toBe(2)
    expect(idx.get('a')?.name).toBe('second')
    expect(idx.get('b')?.name).toBe('Sleep')
  })

  test('groupBy collects items into per-key arrays preserving order', () => {
    const groups = groupBy(
      [
        makeActivity({ id: '1', source_bullet_id: 'p' }),
        makeActivity({ id: '2', source_bullet_id: 'q' }),
        makeActivity({ id: '3', source_bullet_id: 'p' }),
      ],
      (a) => a.source_bullet_id,
    )
    expect([...groups.keys()]).toEqual(['p', 'q'])
    expect(groups.get('p')?.map((a) => a.id)).toEqual(['1', '3'])
    expect(groups.get('q')).toHaveLength(1)
  })
})

// --- suggestion mapping ---------------------------------------------------------------------

describe('suggestionLabel + suggestionSummary', () => {
  test('label maps the target kind to its human heading', () => {
    expect(suggestionLabel(makeSuggestion({ target_kind: 'task' }))).toBe('Task')
    expect(suggestionLabel(makeSuggestion({ target_kind: 'tracker' }))).toBe('Tracker')
    expect(suggestionLabel(makeSuggestion({ target_kind: 'tracker_entry' }))).toBe('Tracker')
    expect(suggestionLabel(makeSuggestion({ target_kind: 'activity' }))).toBe('Activity')
  })

  test('summary reads each kind defensively from the payload', () => {
    const trackers = new Map<string, Tracker>([['trk-1', makeTracker({ name: 'Sleep' })]])
    expect(
      suggestionSummary(
        makeSuggestion({ target_kind: 'task', payload: { title: 'Pay rent' } }),
        trackers,
      ),
    ).toBe('Pay rent')
    expect(suggestionSummary(makeSuggestion({ target_kind: 'task', payload: {} }), trackers)).toBe(
      'New task',
    )
    expect(
      suggestionSummary(
        makeSuggestion({ target_kind: 'tracker', payload: { name: 'Mood' } }),
        trackers,
      ),
    ).toBe('Mood')
    expect(
      suggestionSummary(
        makeSuggestion({
          target_kind: 'activity',
          payload: { name: 'Run', quantity: 4, unit: 'km' },
        }),
        trackers,
      ),
    ).toBe('Run · 4 km')
    expect(
      suggestionSummary(
        makeSuggestion({
          target_kind: 'tracker_entry',
          payload: { tracker_id: 'trk-1', value: 7 },
        }),
        trackers,
      ),
    ).toBe('Sleep · 7')
  })

  test('summary fallbacks for the missing-field / unknown-tracker branches', () => {
    const trackers = new Map<string, Tracker>([['trk-1', makeTracker({ name: 'Sleep' })]])
    // tracker with no name → 'New tracker'.
    expect(
      suggestionSummary(makeSuggestion({ target_kind: 'tracker', payload: {} }), trackers),
    ).toBe('New tracker')
    // activity with quantity but no unit → "name · qty" (no trailing unit).
    expect(
      suggestionSummary(
        makeSuggestion({ target_kind: 'activity', payload: { name: 'Pushups', quantity: 20 } }),
        trackers,
      ),
    ).toBe('Pushups · 20')
    // activity with no quantity → bare name.
    expect(
      suggestionSummary(
        makeSuggestion({ target_kind: 'activity', payload: { name: 'Meditated' } }),
        trackers,
      ),
    ).toBe('Meditated')
    // tracker_entry whose tracker_id is unknown → 'Tracker · value' fallback label.
    expect(
      suggestionSummary(
        makeSuggestion({
          target_kind: 'tracker_entry',
          payload: { tracker_id: 'missing', value: 3 },
        }),
        trackers,
      ),
    ).toBe('Tracker · 3')
  })
})

describe('suggestionRow', () => {
  test('maps a suggestion to its row shape with the kind glyph and passthrough fields', () => {
    const row = suggestionRow(makeSuggestion(), new Map(), false)
    expect(row.id).toBe('sug-1')
    expect(row.sourceBulletId).toBe(BULLET)
    expect(row.glyph).toBe(GLYPH.task)
    expect(row.label).toBe('Task')
    expect(row.summary).toBe('Call the dentist')
    expect(row.tier).toBe('suggest')
    expect(row.targetKind).toBe('task')
    expect(row.staged).toBe(false)
  })

  test('tag: a staged row reads "will apply" (indigo) regardless of tier', () => {
    const row = suggestionRow(makeSuggestion({ tier: 'ask' }), new Map(), true)
    expect(row.staged).toBe(true)
    expect(row.tag).toEqual({ text: 'will apply', className: 'text-indigo' })
  })

  test('tag: an un-staged ask row reads "your call" (ochre)', () => {
    const row = suggestionRow(makeSuggestion({ tier: 'ask' }), new Map(), false)
    expect(row.tag).toEqual({ text: 'your call', className: 'text-ochre' })
  })

  test('tag: an un-staged suggest row reads "suggested" (faint)', () => {
    const row = suggestionRow(makeSuggestion({ tier: 'suggest' }), new Map(), false)
    expect(row.tag).toEqual({ text: 'suggested', className: 'text-faint' })
  })
})
