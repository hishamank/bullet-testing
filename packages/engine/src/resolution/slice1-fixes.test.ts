/**
 * Slice-1 engine fixes (CLAUDE.md §5): capture-anchored dates, Event vs Task routing, record
 * timestamps from capture time, no invented tracker values, field-level mark-done.
 */
import { describe, expect, test } from 'vite-plus/test'
import { ENGINE_CONFIG_DEFAULTS } from '../config'
import type { Candidate } from '../extraction/schema'
import type { ExtractionSnapshot } from '../extraction/snapshot'
import { zonedToEpoch } from '../time/zoned'
import { type ResolvedSuggestion, resolveCandidates } from './resolve'

const config = ENGINE_CONFIG_DEFAULTS
const PARIS = 'Europe/Paris'
// Thursday 2026-10-15 09:12 in Paris (UTC+2).
const CAPTURED = Date.UTC(2026, 9, 15, 7, 12)
const CTX = { capturedAt: CAPTURED, timezone: PARIS }
const EMPTY: ExtractionSnapshot = { trackers: [], openTasks: [] }
const paris = (month: number, day: number, hour = 0, minute = 0) =>
  zonedToEpoch({ year: 2026, month, day, hour, minute }, PARIS)

function candidate(overrides: Partial<Candidate>): Candidate {
  return {
    kind: 'activity',
    orientation: 'happened',
    text: 'something',
    fields: {},
    confidence: 0.9,
    ...overrides,
  }
}

function one(c: Candidate, snapshot: ExtractionSnapshot = EMPTY): ResolvedSuggestion {
  const { suggestions } = resolveCandidates([c], snapshot, config, CTX)
  expect(suggestions).toHaveLength(1)
  return suggestions[0] as ResolvedSuggestion
}

describe('relative dates resolve against capture time + zone', () => {
  test('task "call mom tomorrow" → due at local midnight of Oct 16', () => {
    const s = one(
      candidate({
        kind: 'task',
        orientation: 'future_oneoff',
        text: 'call mom tomorrow',
        fields: { title: 'call mom', when: 'tomorrow' },
      }),
    )
    expect(s.target_kind).toBe('task')
    expect(s.payload.due_at).toBe(paris(10, 16))
  })

  test('the date phrase is found in the text when the model omits "when"', () => {
    const s = one(
      candidate({
        kind: 'task',
        orientation: 'future_oneoff',
        text: 'renew passport by friday',
        fields: { title: 'renew passport' },
      }),
    )
    expect(s.payload.due_at).toBe(paris(10, 16))
  })

  test('a numeric due_at from the model is ignored (the model never does date math)', () => {
    const s = one(
      candidate({
        kind: 'task',
        orientation: 'future_oneoff',
        text: 'buy milk',
        fields: { title: 'buy milk', due_at: 123 },
      }),
    )
    expect(s.payload.due_at).toBeNull()
  })

  test('event "dentist Thursday 3pm until 4pm at Main St" → starts 15:00 local, ends 16:00', () => {
    const s = one(
      candidate({
        kind: 'event',
        orientation: 'future_oneoff',
        text: 'dentist Thursday 3pm',
        fields: { title: 'dentist', when: 'Thursday 3pm', end_when: '4pm', location: 'Main St' },
      }),
    )
    expect(s).toMatchObject({ target_kind: 'event', operation: 'create', target_id: null })
    expect(s.payload).toEqual({
      title: 'dentist',
      starts_at: paris(10, 15, 15),
      ends_at: paris(10, 15, 16),
      all_day: false,
      location: 'Main St',
      notes: null,
    })
  })

  test('the capture zone matters: the same phrase in New York is a different instant', () => {
    const ny = { capturedAt: CAPTURED, timezone: 'America/New_York' } // 03:12 local, Thursday
    const { suggestions } = resolveCandidates(
      [
        candidate({
          kind: 'event',
          orientation: 'future_oneoff',
          fields: { title: 'call', when: 'today 3pm' },
        }),
      ],
      EMPTY,
      config,
      ny,
    )
    expect(suggestions[0]?.payload.starts_at).toBe(Date.UTC(2026, 9, 15, 19))
  })
})

describe('future happenings route to Event vs Task', () => {
  test('an event with only a date is an all-day event', () => {
    const s = one(
      candidate({
        kind: 'event',
        orientation: 'future_oneoff',
        fields: { title: "Sam's birthday", when: 'saturday' },
      }),
    )
    expect(s.target_kind).toBe('event')
    expect(s.payload).toMatchObject({ starts_at: paris(10, 17), all_day: true, ends_at: null })
  })

  test('an "event" with no date at all falls back to a task (an event needs a time)', () => {
    const s = one(
      candidate({
        kind: 'event',
        orientation: 'future_oneoff',
        fields: { title: 'book a dinner' },
      }),
    )
    expect(s.target_kind).toBe('task')
    expect(s.payload.due_at).toBeNull()
  })

  test('a "task" that is an appointment at a clock time is promoted to an event', () => {
    const s = one(
      candidate({
        kind: 'task',
        orientation: 'future_oneoff',
        text: 'dinner with Sam friday 8pm',
        fields: { title: 'dinner with Sam', when: 'friday 8pm' },
      }),
    )
    expect(s.target_kind).toBe('event')
    expect(s.payload.starts_at).toBe(paris(10, 16, 20))
  })

  test('a dated task without an appointment noun stays a task', () => {
    const s = one(
      candidate({
        kind: 'task',
        orientation: 'future_oneoff',
        fields: { title: 'pay rent', when: 'friday 8pm' },
      }),
    )
    expect(s.target_kind).toBe('task')
    expect(s.payload.due_at).toBe(paris(10, 16, 20))
  })

  test('event creates are capped at suggest by default, even when confident', () => {
    const s = one(
      candidate({
        kind: 'event',
        orientation: 'future_oneoff',
        confidence: 0.99,
        fields: { title: 'flight', when: 'tomorrow 7am' },
      }),
    )
    expect(s.tier).toBe('suggest')
    const { suggestions } = resolveCandidates(
      [
        candidate({
          kind: 'event',
          orientation: 'future_oneoff',
          confidence: 0.99,
          fields: { title: 'flight', when: 'tomorrow 7am' },
        }),
      ],
      EMPTY,
      { ...config, autoCreateEvents: true },
      CTX,
    )
    expect(suggestions[0]?.tier).toBe('auto')
  })

  test('a past "event" is a record of something that happened → activity', () => {
    const s = one(candidate({ kind: 'event', orientation: 'happened', fields: { name: 'dinner' } }))
    expect(s.target_kind).toBe('activity')
  })

  test('recurring tasks/events are skipped (recurrence is a later slice), not mis-minted', () => {
    const out = resolveCandidates(
      [candidate({ kind: 'event', orientation: 'future_recurring', fields: { title: 'standup' } })],
      EMPTY,
      config,
      CTX,
    )
    expect(out).toEqual({ suggestions: [], skipped: 1 })
  })
})

describe('record timestamps default to capture time, not processing time', () => {
  const mood: ExtractionSnapshot = {
    trackers: [
      {
        id: 't-mood',
        name: 'mood',
        input_type: 'scale',
        config: { input_type: 'scale', min: 1, max: 5 },
      },
    ],
    openTasks: [],
  }

  test('activity with no date → occurred_at = captured_at', () => {
    const s = one(candidate({ fields: { name: 'meditated' } }))
    expect(s.payload.occurred_at).toBe(CAPTURED)
  })

  test('tracker entry with no date → logged_at = captured_at', () => {
    const s = one(
      candidate({ kind: 'tracker_entry', referenceName: 'mood', fields: { value: 4 } }),
      mood,
    )
    expect(s.target_kind).toBe('tracker_entry')
    expect(s.payload.logged_at).toBe(CAPTURED)
  })

  test('"ran 5k yesterday" → occurred yesterday (local midnight)', () => {
    const s = one(
      candidate({ text: 'ran 5k yesterday', fields: { name: 'ran 5k', when: 'yesterday' } }),
    )
    expect(s.payload.occurred_at).toBe(paris(10, 14))
  })

  test('"ran at 7am" → 07:00 today local', () => {
    const s = one(candidate({ text: 'ran at 7am', fields: { name: 'run' } }))
    expect(s.payload.occurred_at).toBe(paris(10, 15, 7))
  })

  test('a record is never dated after its capture', () => {
    const s = one(candidate({ fields: { name: 'ran', when: 'tonight' } }))
    expect(s.payload.occurred_at).toBe(CAPTURED)
  })
})

describe('a matched scale/number tracker with no value does not invent one', () => {
  const trackers: ExtractionSnapshot = {
    trackers: [
      {
        id: 't-mood',
        name: 'mood',
        input_type: 'scale',
        config: { input_type: 'scale', min: 1, max: 5 },
      },
      { id: 't-weight', name: 'weight', input_type: 'number', config: { input_type: 'number' } },
      { id: 't-meds', name: 'meds', input_type: 'boolean', config: { input_type: 'boolean' } },
    ],
    openTasks: [],
  }

  test('scale with no value → NO tracker_entry (no silent minimum); kept as a value-less activity', () => {
    const s = one(
      candidate({ kind: 'tracker_entry', text: 'thinking about my mood', referenceName: 'mood' }),
      trackers,
    )
    expect(s.target_kind).toBe('activity')
    expect(s.payload.quantity).toBeNull()
  })

  test('number with no value → no tracker_entry', () => {
    const s = one(candidate({ kind: 'tracker_entry', referenceName: 'weight' }), trackers)
    expect(s.target_kind).toBe('activity')
  })

  test('a numeric string value is still a reading', () => {
    const s = one(
      candidate({ kind: 'tracker_entry', referenceName: 'weight', fields: { value: '72.5' } }),
      trackers,
    )
    expect(s).toMatchObject({ target_kind: 'tracker_entry', target_id: 't-weight' })
    expect(s.payload.value).toBe(72.5)
  })

  test('a real scale value is still logged (and clamped)', () => {
    const s = one(
      candidate({ kind: 'tracker_entry', referenceName: 'mood', fields: { value: 9 } }),
      trackers,
    )
    expect(s.payload.value).toBe(5)
  })

  test('a boolean tracker mentioned as happened logs true, not false', () => {
    const s = one(
      candidate({ kind: 'tracker_entry', text: 'took meds', referenceName: 'meds' }),
      trackers,
    )
    expect(s).toMatchObject({ target_kind: 'tracker_entry', target_id: 't-meds' })
    expect(s.payload.value).toBe(true)
  })
})

describe('mark-done is a field-level patch with a conservative tier', () => {
  const tasks: ExtractionSnapshot = {
    trackers: [],
    openTasks: [
      {
        id: 'k1',
        title: 'call mom',
        status: 'todo',
        notes: 'about the trip',
        due_at: 5,
        priority: 'P1',
      },
      {
        id: 'k2',
        title: 'call the plumber about the leak',
        status: 'todo',
        notes: null,
        due_at: null,
        priority: null,
      },
    ],
  }

  test('payload is only { status: done } — no stale snapshot of other fields', () => {
    const s = one(
      candidate({ text: 'called mom', referenceName: 'call mom', confidence: 0.95 }),
      tasks,
    )
    expect(s).toMatchObject({ target_kind: 'task', operation: 'update', target_id: 'k1' })
    expect(s.payload).toEqual({ status: 'done' })
  })

  test('an EXACT title match may auto-apply', () => {
    const s = one(
      candidate({ text: 'call mom', referenceName: 'call mom', confidence: 0.95 }),
      tasks,
    )
    expect(s.tier).toBe('auto')
  })

  test('a containment match is capped at suggest', () => {
    const s = one(
      candidate({
        text: 'called the plumber',
        referenceName: 'call the plumber',
        confidence: 0.99,
      }),
      tasks,
    )
    expect(s.target_id).toBe('k2')
    expect(s.tier).toBe('suggest')
  })
})
