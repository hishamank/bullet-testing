/**
 * Decisions 3 and 4 (2026-10-19): readings never become value-less activities, and a tracker is
 * named with a short noun. Plus the routing backstops: no invented records in a plan, and a
 * reminder is a task, not a tracker.
 */
import { describe, expect, test } from 'vite-plus/test'
import { ENGINE_CONFIG_DEFAULTS } from '../config'
import type { Candidate } from '../extraction/schema'
import type { ExtractionSnapshot } from '../extraction/snapshot'
import { zonedToEpoch } from '../time/zoned'
import { trackerName, trackerNounFrom } from './naming'
import { convertDuration, readingFromFields, readingFromText } from './reading'
import { readingAsActivity, resolveCandidates, type ThoughtContext } from './resolve'

const config = ENGINE_CONFIG_DEFAULTS
const PARIS = 'Europe/Paris'
// Thursday 2026-10-15 09:12 in Paris.
const CTX = { capturedAt: Date.UTC(2026, 9, 15, 7, 12), timezone: PARIS }
const EMPTY: ExtractionSnapshot = { trackers: [], openTasks: [] }

function candidate(overrides: Partial<Candidate>): Candidate {
  return {
    kind: 'activity',
    orientation: 'happened',
    text: 'something',
    fields: {},
    confidence: 0.95,
    ...overrides,
  }
}

const resolve = (c: Candidate, snapshot = EMPTY, thought: ThoughtContext = {}) =>
  resolveCandidates([c], snapshot, config, CTX, thought)

describe('reading parsing', () => {
  test.each([
    ['slept 6 hours', { value: 6, unit: 'h', scale: null }],
    ['Slept 6h.', { value: 6, unit: 'h', scale: null }],
    ['slept 7h30 last night', { value: 7.5, unit: 'h', scale: null }],
    ['slept six hours', { value: 6, unit: 'h', scale: null }],
    ["j'ai dormi 7 heures", { value: 7, unit: 'h', scale: null }],
    ['nemet 5 sa3at', { value: 5, unit: 'h', scale: null }],
    ['meditated 20 minutes', { value: 20, unit: 'min', scale: null }],
    ['ran 5k', { value: 5, unit: 'km', scale: null }],
    ['weight 72.5 kg', { value: 72.5, unit: 'kg', scale: null }],
    ['drank 3 glasses of water', { value: 3, unit: 'glasses', scale: null }],
    ['mood 2 sur 5', { value: 2, unit: null, scale: { min: 1, max: 5 } }],
    ['mood 3/5', { value: 3, unit: null, scale: { min: 1, max: 5 } }],
    ['energy 3 out of 5 today', { value: 3, unit: null, scale: { min: 1, max: 5 } }],
  ])('%s', (text, want) => {
    expect(readingFromText(text, { allowBare: false })).toMatchObject(want)
  })

  test('a bare number only when the text is known to be a reading', () => {
    expect(readingFromText('mood 3', { allowBare: false })).toBeNull()
    expect(readingFromText('mood 3', { allowBare: true })).toMatchObject({
      value: 3,
      unit: null,
      scale: null,
    })
  })

  test('clock times and plans are not readings', () => {
    expect(readingFromText('went to bed at 11pm', { allowBare: true })).toBeNull()
    expect(readingFromText('RDV à 15h', { allowBare: false })).toBeNull()
    expect(readingFromText('meditated', { allowBare: true })).toBeNull()
  })

  test("the model's fields: value, quantity, duration (with its unit), numeric strings", () => {
    expect(readingFromFields({ duration: 20, unit: 'minutes' })).toMatchObject({
      value: 20,
      unit: 'min',
    })
    expect(readingFromFields({ value: '6 hours' })).toMatchObject({ value: 6, unit: 'h' })
    expect(readingFromFields({ quantity: '3' })).toMatchObject({ value: 3, unit: null })
    expect(readingFromFields({ hours: 7 })).toMatchObject({ value: 7, unit: 'h' })
    expect(readingFromFields({ name: 'meditated' })).toBeNull()
  })

  test('durations convert between hours and minutes', () => {
    expect(convertDuration(1.5, 'h', 'min')).toBe(90)
    expect(convertDuration(90, 'min', 'h')).toBe(1.5)
    expect(convertDuration(5, 'km', 'h')).toBeNull()
  })
})

describe('tracker names: a short noun, never the reading', () => {
  test.each([
    ['Slept 6 hours.', 'Sleep'],
    ['slept', 'Sleep'],
    ['mood 2 sur 5', 'Mood'],
    ['energy level 3 out of 5 today', 'Energy'],
    ['Meditated 20 minutes.', 'Meditation'],
    ['ran 5k', 'Run'],
    ['drank 3 glasses of water', 'Water'],
    ['smoked 3 cigarettes', 'Cigarettes'],
    ['weighed 72kg this morning', 'Weight'],
    ['hours of sleep', 'Sleep'],
    ['sleep duration', 'Sleep'],
    ['I slept seven hours last night', 'Sleep'],
    ['run distance', 'Run'],
    ['sleep quality 4/5', 'Sleep Quality'],
    ["j'ai dormi 7 heures", 'Sommeil'],
    ['humeur 3/5', 'Humeur'],
    ['nemet 5 sa3at', 'Nom'],
    ['ran 5k with Sam in the park', 'Run'],
  ])('%s → %s', (text, name) => {
    expect(trackerNounFrom(text)).toBe(name)
  })

  test('the model’s name first, cleaned; a fallback when nothing is nameable', () => {
    expect(trackerName(['sleep', 'Slept 6 hours.'])).toBe('Sleep')
    expect(trackerName(['mood 2 sur 5.'])).toBe('Mood')
    expect(trackerName([null, '', '6/10'])).toBe('Tracker')
  })
})

describe('decision 3: readings are tracker entries with their value', () => {
  test('a reading whose value the model lost is recovered from the text', () => {
    // Live, run 1: "Slept 6 hours." → an auto activity named after the sentence, quantity null.
    const { suggestions, questions } = resolve(
      candidate({ text: 'Slept 6 hours.', fields: { name: 'Slept 6 hours.' } }),
      EMPTY,
      { kind: 'tracker', text: 'Slept 6 hours.' },
    )
    expect(suggestions.map((s) => [s.target_kind, s.operation, s.tier])).toEqual([
      ['tracker', 'create', 'suggest'],
      ['tracker_entry', 'create', 'suggest'],
    ])
    expect(suggestions[0]?.payload).toMatchObject({
      name: 'Sleep',
      config: { input_type: 'number', unit: 'h' },
    })
    expect(suggestions[1]).toMatchObject({ payload: { value: 6 }, dependsOn: 0 })
    expect(questions).toEqual([
      {
        topic: 'new_tracker',
        text: 'Start tracking Sleep?',
        options: ['Yes', 'No'],
        suggestionIndex: 0,
      },
    ])
  })

  test('the model\'s `duration` is the value ("Meditated 20 minutes")', () => {
    const { suggestions } = resolve(
      candidate({
        text: 'Meditated 20 minutes.',
        fields: { name: 'Meditated 20 minutes', duration: 20, unit: 'minutes' },
      }),
    )
    expect(suggestions[0]?.payload).toMatchObject({
      name: 'Meditation',
      config: { input_type: 'number', unit: 'min' },
    })
    expect(suggestions[1]?.payload.value).toBe(20)
  })

  test('a scale reading offers a scale tracker', () => {
    const { suggestions } = resolve(
      candidate({ kind: 'tracker_entry', text: 'mood 2 sur 5', fields: { name: 'mood 2 sur 5' } }),
    )
    expect(suggestions[0]?.payload).toEqual({
      name: 'Mood',
      input_type: 'scale',
      config: { input_type: 'scale', min: 1, max: 5 },
    })
    expect(suggestions[1]?.payload.value).toBe(2)
  })

  test('a later reading logs under the existing tracker, converting hours and minutes', () => {
    const snapshot: ExtractionSnapshot = {
      trackers: [
        {
          id: 't-sleep',
          name: 'Sleep',
          input_type: 'number',
          config: { input_type: 'number', unit: 'h' },
        },
        {
          id: 't-med',
          name: 'Meditation',
          input_type: 'number',
          config: { input_type: 'number', unit: 'min' },
        },
      ],
      openTasks: [],
    }
    const sleep = resolve(
      candidate({ text: 'slept 7h30', fields: { name: 'slept 7h30' } }),
      snapshot,
      { kind: 'tracker' },
    ).suggestions
    expect(sleep).toHaveLength(1)
    expect(sleep[0]).toMatchObject({
      target_kind: 'tracker_entry',
      operation: 'append',
      target_id: 't-sleep',
      payload: { value: 7.5 },
      tier: 'suggest',
    })
    const med = resolve(
      candidate({ text: 'meditated for an hour and a half', fields: { hours: 1.5 } }),
      snapshot,
    ).suggestions
    expect(med[0]).toMatchObject({ target_id: 't-med', payload: { value: 90 } })
  })

  test("the model's link to an unrelated tracker is not trusted (live: slept → Meditation)", () => {
    const snapshot: ExtractionSnapshot = {
      trackers: [
        {
          id: 't-med',
          name: 'Meditation',
          input_type: 'number',
          config: { input_type: 'number', unit: 'min' },
        },
      ],
      openTasks: [],
    }
    const { suggestions } = resolve(
      candidate({
        kind: 'tracker_entry',
        text: 'I slept seven hours last night.',
        referenceName: 'Meditation',
        fields: { tracker: 'Meditation', value: 7 },
      }),
      snapshot,
      { kind: 'tracker' },
    )
    expect(suggestions.map((s) => [s.target_kind, s.operation])).toEqual([
      ['tracker', 'create'],
      ['tracker_entry', 'create'],
    ])
    expect(suggestions[0]?.payload.name).toBe('Sleep')
    expect(suggestions[1]?.payload.value).toBe(7)
  })

  test('only a truly value-less activity may auto-apply', () => {
    const { suggestions } = resolve(candidate({ text: 'meditated', fields: { name: 'meditated' } }))
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]).toMatchObject({
      target_kind: 'activity',
      tier: 'auto',
      payload: { quantity: null },
    })
  })

  test('a value that does not fit the matched tracker stays on an activity, never auto', () => {
    const snapshot: ExtractionSnapshot = {
      trackers: [
        {
          id: 't-mood',
          name: 'Mood',
          input_type: 'single_select',
          config: { input_type: 'single_select', options: ['good', 'bad'] },
        },
      ],
      openTasks: [],
    }
    const { suggestions } = resolve(
      candidate({ kind: 'tracker_entry', text: 'mood 3', fields: { tracker: 'mood', value: 3 } }),
      snapshot,
    )
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]).toMatchObject({
      target_kind: 'activity',
      tier: 'suggest',
      payload: { quantity: 3 },
    })
  })
})

describe('routing backstops', () => {
  test('a plan thought yields no invented record ("Pay the bill" → no "Paid the bill")', () => {
    const { suggestions, skipped } = resolve(
      candidate({
        text: 'Pay the electricity bill.',
        fields: { name: 'Paid the electricity bill.' },
      }),
      EMPTY,
      { kind: 'task', text: 'Pay the electricity bill.' },
    )
    expect(suggestions).toEqual([])
    expect(skipped).toBe(1)
  })

  test('a plan thought can still close an open task it names', () => {
    const snapshot: ExtractionSnapshot = {
      trackers: [],
      openTasks: [
        {
          id: 'task-1',
          title: 'call the dentist',
          status: 'todo',
          notes: null,
          due_at: null,
          priority: null,
        },
      ],
    }
    const { suggestions } = resolve(
      candidate({
        kind: 'task',
        text: 'called the dentist',
        fields: { title: 'call the dentist' },
      }),
      snapshot,
      { kind: 'task' },
    )
    expect(suggestions[0]).toMatchObject({ target_kind: 'task', operation: 'update' })
  })

  test('"Remind me to buy olive oil tomorrow" is a task, not a tracker', () => {
    const { suggestions } = resolve(
      candidate({
        kind: 'tracker',
        orientation: 'future_recurring',
        text: 'Remind me to buy olive oil tomorrow.',
        fields: { name: 'buy olive oil' },
      }),
    )
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]).toMatchObject({
      target_kind: 'task',
      operation: 'create',
      payload: { due_at: zonedToEpoch({ year: 2026, month: 10, day: 16 }, PARIS) },
    })
  })

  test('a genuinely recurring tracker stays a definition', () => {
    const { suggestions } = resolve(
      candidate({
        kind: 'tracker',
        orientation: 'future_recurring',
        text: 'I want to track my mood every day',
        fields: { name: 'mood', input_type: 'scale' },
      }),
    )
    expect(suggestions[0]).toMatchObject({ target_kind: 'tracker', payload: { name: 'Mood' } })
  })
})

describe('review follow-ups (2026-10-19)', () => {
  const meditation = {
    id: 't-med',
    name: 'Meditation',
    input_type: 'number' as const,
    config: { input_type: 'number' as const, unit: 'min' },
  }
  const sleep = {
    id: 't-sleep',
    name: 'Sleep',
    input_type: 'number' as const,
    config: { input_type: 'number' as const, unit: 'h' },
  }

  test('a wrong model reference still finds the right tracker among the others', () => {
    const { suggestions } = resolve(
      candidate({
        kind: 'tracker_entry',
        text: 'I slept seven hours last night.',
        referenceName: 'Meditation',
        fields: { tracker: 'Meditation', value: 7 },
      }),
      { trackers: [meditation, sleep], openTasks: [] },
      { kind: 'tracker' },
    )
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]).toMatchObject({
      target_kind: 'tracker_entry',
      operation: 'append',
      target_id: 't-sleep',
      payload: { value: 7 },
    })
  })

  test('another scale or unit is never clamped or converted silently', () => {
    const mood = {
      id: 't-mood',
      name: 'Mood',
      input_type: 'scale' as const,
      config: { input_type: 'scale' as const, min: 1, max: 5 },
    }
    const run = {
      id: 't-run',
      name: 'Run',
      input_type: 'number' as const,
      config: { input_type: 'number' as const, unit: 'km' },
    }
    const snapshot = { trackers: [mood, run], openTasks: [] }
    const ten = resolve(candidate({ kind: 'tracker_entry', text: 'mood 7/10' }), snapshot, {
      kind: 'tracker',
    }).suggestions
    expect(ten).toEqual([
      expect.objectContaining({
        target_kind: 'activity',
        tier: 'suggest',
        payload: expect.objectContaining({ quantity: 7 }),
      }),
    ])
    const miles = resolve(candidate({ text: 'ran 5 miles' }), snapshot).suggestions
    expect(miles).toEqual([
      expect.objectContaining({
        target_kind: 'activity',
        tier: 'suggest',
        payload: expect.objectContaining({ quantity: 5, unit: 'mi' }),
      }),
    ])
    const km = resolve(candidate({ text: 'ran 5k' }), snapshot).suggestions
    expect(km[0]).toMatchObject({
      target_kind: 'tracker_entry',
      target_id: 't-run',
      payload: { value: 5 },
    })
  })

  test('"ran 5k in 30 min": the first thing said is the reading', () => {
    expect(readingFromText('ran 5k in 30 min', { allowBare: false })).toMatchObject({
      value: 5,
      unit: 'km',
    })
    expect(
      readingFromText('meditated 20 minutes after 2 glasses of water', { allowBare: false }),
    ).toMatchObject({ value: 20, unit: 'min' })
  })

  test('no new tracker for a measured activity nobody tracks ("spent 2 hours at the dentist")', () => {
    const { suggestions } = resolve(
      candidate({
        text: 'spent 2 hours at the dentist',
        fields: { name: 'spent 2 hours at the dentist' },
      }),
      EMPTY,
      { kind: 'activity' },
    )
    expect(suggestions).toEqual([
      expect.objectContaining({
        target_kind: 'activity',
        tier: 'suggest',
        payload: expect.objectContaining({ quantity: 2, unit: 'h' }),
      }),
    ])
    expect(trackerNounFrom("j'ai dormi 7h")).toBe('Sommeil')
    expect(trackerNounFrom('j ai dormi 7h')).toBe('Sommeil')
  })

  test('"start tracking my mood from tomorrow" stays a tracker; a dated plan becomes a task', () => {
    const tracking = resolve(
      candidate({
        kind: 'tracker',
        orientation: 'future_recurring',
        text: 'start tracking my mood from tomorrow',
        fields: { name: 'mood', input_type: 'scale' },
      }),
      EMPTY,
      { kind: 'tracker' },
    ).suggestions
    expect(tracking[0]).toMatchObject({ target_kind: 'tracker', payload: { name: 'Mood' } })
    const plan = resolve(
      candidate({
        kind: 'tracker',
        orientation: 'future_recurring',
        text: 'buy olive oil tomorrow',
        fields: { name: 'olive oil', when: 'tomorrow' },
      }),
      EMPTY,
      { kind: 'task' },
    ).suggestions
    expect(plan[0]?.target_kind).toBe('task')
  })

  test('the kept activity drops the value words even when the model gave the value', () => {
    const { suggestions } = resolve(
      candidate({
        text: 'Slept 6 hours',
        fields: { name: 'Slept 6 hours', value: 6, unit: 'hours' },
      }),
      EMPTY,
      { kind: 'tracker' },
    )
    expect(suggestions[1]?.payload.activity_name).toBe('Slept')
  })

  test('a count of anything keeps its value on the activity, never auto', () => {
    const { suggestions } = resolve(
      candidate({ text: 'ate 2 pizzas', fields: { name: 'ate 2 pizzas' } }),
      EMPTY,
      { kind: 'activity' },
    )
    expect(suggestions).toEqual([
      expect.objectContaining({
        target_kind: 'activity',
        tier: 'suggest',
        payload: expect.objectContaining({ quantity: 2, unit: 'pizzas' }),
      }),
    ])
    expect(readingFromText('did 30 pushups', { allowBare: false })).toMatchObject({
      value: 30,
      unit: 'pushups',
    })
    expect(readingFromText('3 days ago I called mom', { allowBare: false })).toBeNull()
  })

  test('a word after the number is not a unit unless it is a counted thing', () => {
    for (const text of [
      'slept 7 this morning',
      'energy 3 was ok',
      'note 3 mais fatigué',
      'mood 4 thanks',
    ]) {
      expect(readingFromText(text, { allowBare: true })?.unit ?? null, text).toBeNull()
    }
    for (const [text, unit] of [
      ['did 30 pushups', 'pushups'],
      ['ate 2 pizzas', 'pizzas'],
      ['answered 3 emails', 'emails'],
    ] as const) {
      expect(readingFromText(text, { allowBare: false })?.unit, text).toBe(unit)
    }
    expect(readingFromText('went 3 fois au sport', { allowBare: false })).toBeNull()
    const snapshot: ExtractionSnapshot = {
      trackers: [
        {
          id: 't-sleep',
          name: 'Sleep',
          input_type: 'number',
          config: { input_type: 'number', unit: 'h' },
        },
        {
          id: 't-mood',
          name: 'Mood',
          input_type: 'scale',
          config: { input_type: 'scale', min: 1, max: 5 },
        },
      ],
      openTasks: [],
    }
    const sleep = resolve(candidate({ text: 'slept 7 this morning' }), snapshot, {
      kind: 'tracker',
    }).suggestions
    expect(sleep[0]).toMatchObject({ target_id: 't-sleep', payload: { value: 7 } })
    const mood = resolve(
      candidate({ kind: 'tracker_entry', text: 'mood 3 this morning' }),
      snapshot,
      {
        kind: 'tracker',
      },
    ).suggestions
    expect(mood[0]).toMatchObject({ target_id: 't-mood', payload: { value: 3 } })
    // No tracker yet: no stray unit, and the kept activity's name reads cleanly.
    const fresh = resolve(
      candidate({ text: 'slept 7 this morning', fields: { name: 'slept 7 this morning' } }),
      EMPTY,
      { kind: 'tracker' },
    ).suggestions
    expect(fresh[0]?.payload.config).toEqual({ input_type: 'number' })
    expect(fresh[1]?.payload.activity_name).not.toMatch(/\s{2}/)
    expect(trackerNounFrom('mood 2 is low')).toBe('Mood')
  })

  test('a declined tracker keeps its reading as an activity with the value', () => {
    const { suggestions } = resolve(
      candidate({ text: 'Slept 6 hours.', fields: { name: 'Slept 6 hours.' } }),
      EMPTY,
      { kind: 'tracker' },
    )
    const [tracker, entry] = suggestions
    expect(entry?.payload.activity_name).toBe('Slept')
    expect(
      readingAsActivity(
        { ...entry!.payload, owner_id: 'o', source_bullet_id: 'b' },
        tracker!.payload,
      ),
    ).toEqual({
      name: 'Slept',
      occurred_at: entry!.payload.logged_at,
      tracker_id: null,
      notes: null,
      quantity: 6,
      unit: 'h',
      owner_id: 'o',
      source_bullet_id: 'b',
      source_thought_id: null,
    })
  })
})
