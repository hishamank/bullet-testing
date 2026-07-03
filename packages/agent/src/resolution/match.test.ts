/**
 * Unit tests for the DETERMINISTIC matcher (match.ts). No LLM is involved — the matcher is pure.
 * These pin the exact signals (referenceName / extracted fields.name+title / text), the
 * normalisation (case/whitespace), the inflection tolerance (prefix-related tokens), and the score
 * bands the resolver's thresholds rely on.
 */

import { describe, expect, test } from 'vitest'
import type { Candidate } from '../extraction/schema'
import type { SnapshotTask, SnapshotTracker } from '../extraction/snapshot'
import { matchOpenTask, matchTracker } from './match'

/** A candidate with sensible defaults (empty text/fields, no referenceName). */
function candidate(overrides: Partial<Candidate>): Candidate {
  return {
    kind: 'activity',
    orientation: 'happened',
    text: '',
    fields: {},
    confidence: 0.9,
    ...overrides,
  }
}

const tracker = (id: string, name: string): SnapshotTracker => ({
  id,
  name,
  input_type: 'number',
  config: { input_type: 'number' },
})

const task = (id: string, title: string): SnapshotTask => ({
  id,
  title,
  status: 'todo',
  notes: null,
  due_at: null,
  priority: null,
})

describe('matchTracker — deterministic signals', () => {
  const trackers = [tracker('t-mood', 'mood'), tracker('t-run', 'running')]

  test('matches the explicit referenceName (exact → score 1)', () => {
    const m = matchTracker(candidate({ referenceName: 'mood' }), trackers)
    expect(m?.item.id).toBe('t-mood')
    expect(m?.score).toBe(1)
  })

  test('REGRESSION: matches the EXTRACTED fields.name when referenceName is absent', () => {
    const m = matchTracker(candidate({ fields: { name: 'mood', value: 3 } }), trackers)
    expect(m?.item.id).toBe('t-mood')
    expect(m?.score).toBe(1)
  })

  test('matches fields.title as well as fields.name', () => {
    const m = matchTracker(candidate({ fields: { title: 'mood' } }), trackers)
    expect(m?.item.id).toBe('t-mood')
    expect(m?.score).toBe(1)
  })

  test('is case- and whitespace-insensitive', () => {
    const m = matchTracker(candidate({ fields: { name: '  MOOD  ' } }), trackers)
    expect(m?.item.id).toBe('t-mood')
    expect(m?.score).toBe(1)
  })

  test('token containment: "mood" matches a "mood scale" tracker (≥ 0.9)', () => {
    const m = matchTracker(candidate({ fields: { name: 'mood' } }), [tracker('t', 'mood scale')])
    expect(m?.item.id).toBe('t')
    expect(m?.score).toBeGreaterThanOrEqual(0.9)
  })

  test('inflection: plural "moods" → "mood" and prefix "run" → "running" both match (≥ 0.9)', () => {
    const moods = matchTracker(candidate({ fields: { name: 'moods' } }), trackers)
    expect(moods?.item.id).toBe('t-mood')
    expect(moods?.score).toBeGreaterThanOrEqual(0.9)

    const run = matchTracker(candidate({ fields: { name: 'run' } }), trackers)
    expect(run?.item.id).toBe('t-run')
    expect(run?.score).toBeGreaterThanOrEqual(0.9)
  })

  test('a single-character typo lands in the borderline band [0.55, 0.85)', () => {
    // "tird" → "tired": handled by the fuzzy signal, deliberately NOT a strong match.
    const m = matchTracker(candidate({ fields: { name: 'tird' } }), [tracker('t-tired', 'tired')])
    expect(m?.item.id).toBe('t-tired')
    expect(m?.score).toBeGreaterThanOrEqual(0.55)
    expect(m?.score).toBeLessThan(0.85)
  })

  test('unrelated text returns no match (undefined)', () => {
    const m = matchTracker(
      candidate({ fields: { name: 'banana' }, text: 'ate a banana' }),
      trackers,
    )
    expect(m).toBeUndefined()
  })

  test('picks the strongest tracker among several', () => {
    const m = matchTracker(candidate({ fields: { name: 'running' } }), trackers)
    expect(m?.item.id).toBe('t-run')
    expect(m?.score).toBe(1)
  })

  test('empty snapshot → undefined', () => {
    expect(matchTracker(candidate({ referenceName: 'mood' }), [])).toBeUndefined()
  })
})

describe('matchOpenTask — mutate-instance matching', () => {
  const tasks = [task('task-1', 'call the dentist')]

  test('"called the dentist" (no referenceName) matches the open task "call the dentist" (≥ 0.85)', () => {
    const m = matchOpenTask(candidate({ text: 'called the dentist' }), tasks)
    expect(m?.item.id).toBe('task-1')
    expect(m?.score).toBeGreaterThanOrEqual(0.85)
  })

  test('an unrelated span → no task match (undefined)', () => {
    expect(matchOpenTask(candidate({ text: 'ate lunch' }), tasks)).toBeUndefined()
  })
})
