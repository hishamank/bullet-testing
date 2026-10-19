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

/** The record (activity or reading) a 'happened' candidate produced, next to any tracker offer. */
function record(c: Candidate, snapshot: ExtractionSnapshot = EMPTY): ResolvedSuggestion {
  const { suggestions } = resolveCandidates([c], snapshot, config, CTX)
  const r = suggestions.find((s) => s.target_kind !== 'tracker')
  expect(r).toBeDefined()
  return r as ResolvedSuggestion
}

const recordTime = (s: ResolvedSuggestion) => s.payload.occurred_at ?? s.payload.logged_at

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
      title: 'Dentist',
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
  // Qwen3.5-4B, 2026-10-18: "take the car to the garage before 10am" came back as an event.
  test('an "event" with a deadline ("before 10am") is a task due then', () => {
    const s = one(
      candidate({
        kind: 'event',
        orientation: 'future_oneoff',
        text: 'take the car to the garage before 10am',
        fields: { title: 'take the car to the garage', when: 'before 10am' },
      }),
    )
    expect(s.target_kind).toBe('task')
    expect(s.payload).toMatchObject({
      title: 'Take the car to the garage',
      due_at: paris(10, 15, 10),
    })
  })

  test('deadlines in French and Arabizi too', () => {
    for (const [text, when] of [
      ['wadde l sayyara 3al garage 2abel l 5amis', '2abel l 5amis'],
      ['rendre le dossier avant jeudi', 'avant jeudi'],
    ]) {
      const s = one(
        candidate({
          kind: 'event',
          orientation: 'future_oneoff',
          text,
          fields: { title: text, when },
        }),
      )
      expect(s.target_kind).toBe('task')
      expect(s.payload.due_at).toBe(paris(10, 15))
    }
  })

  test('an appointment "before" a time stays an event ("dinner with Sam before 8pm")', () => {
    const s = one(
      candidate({
        kind: 'event',
        orientation: 'future_oneoff',
        text: 'dinner with Sam before 8pm',
        fields: { title: 'dinner with Sam', when: 'before 8pm' },
      }),
    )
    expect(s.target_kind).toBe('event')
  })

  test('"réunion avec Karim demain à 15h" → an event at 15:00 tomorrow', () => {
    const s = one(
      candidate({
        kind: 'event',
        orientation: 'future_oneoff',
        text: 'Demain réunion avec Karim à 15h',
        fields: { title: 'réunion avec Karim', when: 'Demain à 15h' },
      }),
    )
    expect(s.payload).toMatchObject({ starts_at: paris(10, 16, 15), all_day: false })
  })

  // Qwen3.5-4B, 2026-10-18: it quoted only "Demain" and the meeting became all-day.
  test('a quoted day without its time takes the time from the text ("Demain" + "à 15h")', () => {
    const s = one(
      candidate({
        kind: 'event',
        orientation: 'future_oneoff',
        text: 'Demain réunion avec Karim à 15h',
        fields: { title: 'réunion avec Karim', when: 'Demain' },
      }),
    )
    expect(s.payload).toMatchObject({ starts_at: paris(10, 16, 15), all_day: false })
  })

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
    expect(out).toEqual({ suggestions: [], questions: [], skipped: 1 })
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
      candidate({
        kind: 'tracker_entry',
        text: 'mood 4',
        referenceName: 'mood',
        fields: { value: 4 },
      }),
      mood,
    )
    expect(s.target_kind).toBe('tracker_entry')
    expect(s.payload.logged_at).toBe(CAPTURED)
  })

  test('"ran 5k yesterday" → occurred yesterday at noon, not at its midnight', () => {
    const s = record(
      candidate({ text: 'ran 5k yesterday', fields: { name: 'ran 5k', when: 'yesterday' } }),
    )
    expect(recordTime(s)).toBe(paris(10, 14, 12))
  })

  // Qwen3.5-4B, 2026-10-18: "mood 3/10 today" / "slept 6 hours" were dated at local midnight.
  test('a record dated "today" (no time of day) → the capture time, not midnight', () => {
    const s = record(
      candidate({ text: 'mood 3/10 today', fields: { name: 'mood', value: 3, when: 'today' } }),
    )
    expect(recordTime(s)).toBe(CAPTURED)
    const slept = record(
      candidate({ text: 'slept 6 hours', fields: { name: 'sleep', when: 'lyom' } }),
    )
    expect(recordTime(slept)).toBe(CAPTURED)
  })

  test('"slept 6 hours last night" keeps its time of day (yesterday 20:00)', () => {
    const s = record(
      candidate({ text: 'slept 6 hours', fields: { name: 'sleep', value: 6, when: 'last night' } }),
    )
    expect(recordTime(s)).toBe(paris(10, 14, 20))
  })

  test('a French / Arabizi date phrase dates a record', () => {
    const s = record(
      candidate({ text: 'rkadet 5k mbere7', fields: { name: 'run', when: 'mbere7' } }),
    )
    expect(recordTime(s)).toBe(paris(10, 14, 12))
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
      candidate({
        kind: 'tracker_entry',
        text: 'weight 72.5',
        referenceName: 'weight',
        fields: { value: '72.5' },
      }),
      trackers,
    )
    expect(s).toMatchObject({ target_kind: 'tracker_entry', target_id: 't-weight' })
    expect(s.payload.value).toBe(72.5)
  })

  test('a real scale value is still logged (and clamped)', () => {
    const s = one(
      candidate({
        kind: 'tracker_entry',
        text: 'mood 9',
        referenceName: 'mood',
        fields: { value: 9 },
      }),
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

describe('a reading names its tracker in a field (live Qwen3.5-4B output)', () => {
  // Seen live: { kind: 'tracker_entry', fields: { tracker: 'sleep', value: 6 } } for "Slept 6
  // hours." The offer used to read 'Start tracking "Slept 6 hours."?'.
  const sleep = (fields: Record<string, unknown>) =>
    candidate({ kind: 'tracker_entry', text: 'Slept 6 hours.', fields, confidence: 0.95 })

  test('the offered tracker is named after the field, not the sentence', () => {
    for (const fields of [
      { tracker: 'sleep', value: 6 },
      { tracker_name: 'sleep', value: 6 },
    ]) {
      const { suggestions, questions } = resolveCandidates([sleep(fields)], EMPTY, config, CTX)
      const tracker = suggestions.find((s) => s.target_kind === 'tracker')
      expect(tracker?.payload.name).toBe('Sleep')
      expect(questions[0]?.text).toBe('Start tracking Sleep?')
    }
  })

  test('the field is used to match an existing tracker', () => {
    const snapshot: ExtractionSnapshot = {
      trackers: [
        { id: 't-sleep', name: 'sleep', input_type: 'number', config: { input_type: 'number' } },
      ],
      openTasks: [],
    }
    const s = one(sleep({ tracker: 'sleep', value: 6 }), snapshot)
    expect(s).toMatchObject({
      target_kind: 'tracker_entry',
      operation: 'append',
      target_id: 't-sleep',
    })
  })
})
