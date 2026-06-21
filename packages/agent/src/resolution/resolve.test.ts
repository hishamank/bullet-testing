import {
  acceptSuggestion,
  createBullet,
  createSuggestion,
  createTask,
  createTestDb,
  createUser,
  getTaskById,
  listTasks,
} from '@bullet/db'
import { describe, expect, test } from 'vitest'
import { AGENT_CONFIG_DEFAULTS } from '../config'
import type { Candidate } from '../extraction/schema'
import type { ExtractionSnapshot } from '../extraction/snapshot'
import { buildSnapshot } from '../extraction/snapshot'
import { type ResolvedSuggestion, resolveCandidates, withProvenance } from './resolve'

const config = AGENT_CONFIG_DEFAULTS
const EMPTY: ExtractionSnapshot = { trackers: [], openTasks: [] }

/** The first resolved suggestion, asserting one exists (satisfies noUncheckedIndexedAccess). */
function first(suggestions: ResolvedSuggestion[]): ResolvedSuggestion {
  const s = suggestions[0]
  if (!s) throw new Error('expected at least one resolved suggestion')
  return s
}

/** Build a candidate with sensible defaults. */
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

describe('orientation routing', () => {
  test('happened + no match → create UNLINKED activity (activity-first)', () => {
    const { suggestions } = resolveCandidates(
      [
        candidate({
          orientation: 'happened',
          text: 'wandered around',
          fields: { name: 'wandered' },
        }),
      ],
      EMPTY,
      config,
    )
    expect(suggestions).toHaveLength(1)
    const s = first(suggestions)
    expect(s.target_kind).toBe('activity')
    expect(s.operation).toBe('create')
    expect(s.target_id).toBeNull()
    expect(s.payload.tracker_id).toBeNull()
    expect(s.payload.name).toBe('wandered')
  })

  test('happened + strong tracker match → APPEND a tracker_entry with target_id', () => {
    const snapshot: ExtractionSnapshot = {
      trackers: [{ id: 'tracker-1', name: 'mood', input_type: 'scale' }],
      openTasks: [],
    }
    const { suggestions } = resolveCandidates(
      [
        candidate({
          orientation: 'happened',
          text: 'mood was 4 today',
          referenceName: 'mood',
          fields: { value: 4 },
        }),
      ],
      snapshot,
      config,
    )
    const s = first(suggestions)
    expect(s.target_kind).toBe('tracker_entry')
    expect(s.operation).toBe('append')
    expect(s.target_id).toBe('tracker-1')
    expect(s.payload.value).toBe(4)
  })

  test('happened + strong open-task match → UPDATE that task to done', () => {
    const snapshot: ExtractionSnapshot = {
      trackers: [],
      openTasks: [
        {
          id: 'task-1',
          title: 'call the dentist',
          status: 'todo',
          notes: 'before noon',
          due_at: 123,
          priority: 'P2',
        },
      ],
    }
    const { suggestions } = resolveCandidates(
      [
        candidate({
          orientation: 'happened',
          text: 'called the dentist',
          referenceName: 'call the dentist',
        }),
      ],
      snapshot,
      config,
    )
    const s = first(suggestions)
    expect(s.target_kind).toBe('task')
    expect(s.operation).toBe('update')
    expect(s.target_id).toBe('task-1')
    // The payload carries the matched task's CURRENT fields plus the only mutation (status→done),
    // so the apply engine's full-INSERT-schema re-validation passes (a bare {status} would fail).
    expect(s.payload).toEqual({
      title: 'call the dentist',
      notes: 'before noon',
      due_at: 123,
      priority: 'P2',
      status: 'done',
    })
  })

  test('future_oneoff → create a task', () => {
    const { suggestions } = resolveCandidates(
      [candidate({ kind: 'task', orientation: 'future_oneoff', fields: { title: 'buy milk' } })],
      EMPTY,
      config,
    )
    const s = first(suggestions)
    expect(s.target_kind).toBe('task')
    expect(s.operation).toBe('create')
    expect(s.payload.title).toBe('buy milk')
  })

  test('future_recurring → create a tracker DEFINITION', () => {
    const { suggestions } = resolveCandidates(
      [
        candidate({
          kind: 'tracker',
          orientation: 'future_recurring',
          fields: { name: 'pushups', input_type: 'number' },
        }),
      ],
      EMPTY,
      config,
    )
    const s = first(suggestions)
    expect(s.target_kind).toBe('tracker')
    expect(s.operation).toBe('create')
    expect(s.payload.name).toBe('pushups')
    expect(s.payload.input_type).toBe('number')
  })

  test('durable_fact → SKIPPED (no suggestion, but counted)', () => {
    const { suggestions, skipped } = resolveCandidates(
      [candidate({ orientation: 'durable_fact', text: 'I am vegetarian' })],
      EMPTY,
      config,
    )
    expect(suggestions).toHaveLength(0)
    expect(skipped).toBe(1)
  })
})

describe('tier assignment (§4.5)', () => {
  test('tracker definition is NEVER auto, even at confidence 1', () => {
    const { suggestions } = resolveCandidates(
      [
        candidate({
          kind: 'tracker',
          orientation: 'future_recurring',
          confidence: 1,
          fields: { name: 'water', input_type: 'number' },
        }),
      ],
      EMPTY,
      config,
    )
    expect(first(suggestions).tier).toBe('suggest')
    expect(first(suggestions).tier).not.toBe('auto')
  })

  test('a record (activity) above autoThreshold is auto', () => {
    const { suggestions } = resolveCandidates(
      [candidate({ orientation: 'happened', confidence: 0.95, fields: { name: 'ran' } })],
      EMPTY,
      config,
    )
    expect(first(suggestions).tier).toBe('auto')
  })

  test('task CREATE is capped at suggest by default (not auto) even at confidence 1', () => {
    const { suggestions } = resolveCandidates(
      [
        candidate({
          kind: 'task',
          orientation: 'future_oneoff',
          confidence: 1,
          fields: { title: 't' },
        }),
      ],
      EMPTY,
      config,
    )
    expect(first(suggestions).tier).toBe('suggest')
  })

  test('task CREATE may be auto when autoCreateTasks is enabled', () => {
    const { suggestions } = resolveCandidates(
      [
        candidate({
          kind: 'task',
          orientation: 'future_oneoff',
          confidence: 0.95,
          fields: { title: 't' },
        }),
      ],
      EMPTY,
      { ...config, autoCreateTasks: true },
    )
    expect(first(suggestions).tier).toBe('auto')
  })

  test('below suggestThreshold → ask', () => {
    const { suggestions } = resolveCandidates(
      [candidate({ orientation: 'happened', confidence: 0.2, fields: { name: 'x' } })],
      EMPTY,
      config,
    )
    expect(first(suggestions).tier).toBe('ask')
  })
})

describe('confidence combination', () => {
  test('append confidence blends model confidence with the fuse match score', () => {
    const snapshot: ExtractionSnapshot = {
      trackers: [{ id: 'tracker-1', name: 'mood', input_type: 'scale' }],
      openTasks: [],
    }
    const { suggestions } = resolveCandidates(
      [
        candidate({
          orientation: 'happened',
          referenceName: 'mood',
          confidence: 1,
          fields: { value: 3 },
        }),
      ],
      snapshot,
      config,
    )
    // A perfect match score (1) combined with model confidence 1 stays 1; the blend is the mean.
    expect(first(suggestions).confidence).toBeGreaterThan(0.5)
    expect(first(suggestions).confidence).toBeLessThanOrEqual(1)
  })
})

/**
 * End-to-end APPLY round-trip for the mark-done UPDATE route. A draft-shape assertion is not
 * enough: the apply engine RE-VALIDATES the persisted payload against the full task INSERT
 * schema, so a bare `{ status: 'done' }` is permanently unappliable (INVALID_PAYLOAD). This
 * seeds a real open task, drives a matching 'happened' candidate, persists via withProvenance/
 * createSuggestion, and asserts acceptSuggestion succeeds AND the SAME task row flips to 'done'.
 */
describe('mark-done UPDATE applies end-to-end against a real DB', () => {
  function seedOpenTask() {
    const { db } = createTestDb()
    const user = createUser(db, { name: 'U' })
    const bullet = createBullet(db, { owner_id: user.id, text: 'called the dentist' })
    const task = createTask(db, {
      owner_id: user.id,
      source_bullet_id: bullet.id,
      title: 'call the dentist',
      notes: 'before noon',
      due_at: 1_700_000_000_000,
      priority: 'P2',
    })
    return { db, ownerId: user.id, bulletId: bullet.id, task }
  }

  test('a confident happened match flips the matched task to done (same row, not a new one)', () => {
    const { db, ownerId, bulletId, task } = seedOpenTask()
    const snapshot = buildSnapshot({ db }, ownerId)

    const { suggestions } = resolveCandidates(
      [
        candidate({
          orientation: 'happened',
          text: 'called the dentist',
          referenceName: 'call the dentist',
          confidence: 0.95,
        }),
      ],
      snapshot,
      config,
    )
    const draft = first(suggestions)
    expect(draft.target_kind).toBe('task')
    expect(draft.operation).toBe('update')
    expect(draft.target_id).toBe(task.id)
    // Instance updates are auto-eligible (§4.5): a confident mark-done auto-applies.
    expect(draft.tier).toBe('auto')

    // Persist with provenance and apply through the real db engine (the re-validation path).
    const suggestion = createSuggestion(db, withProvenance(draft, ownerId, bulletId))
    const { result } = acceptSuggestion(db, suggestion.id)

    // The SAME task row is mutated to done — no duplicate task is created.
    expect(result.id).toBe(task.id)
    const after = getTaskById(db, task.id)
    expect(after?.status).toBe('done')
    // Untouched mutable fields are preserved (we re-supplied the live values unchanged).
    expect(after?.title).toBe('call the dentist')
    expect(after?.notes).toBe('before noon')
    expect(after?.due_at).toBe(1_700_000_000_000)
    expect(after?.priority).toBe('P2')
    // Exactly one task row exists for the owner (the update did not mint a second).
    expect(listTasks(db, ownerId)).toHaveLength(1)
  })
})
