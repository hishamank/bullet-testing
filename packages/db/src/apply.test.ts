import type { Activity, Task, Tracker, TrackerEntry } from '@bullet/core'
import { expect, test } from 'vitest'
import { acceptSuggestion, applySuggestion, editSuggestion, rejectSuggestion } from './apply'
import { createTestDb } from './client'
import { DbError } from './errors'
import { getActivityById } from './repositories/activities'
import { createSuggestion, getSuggestionById, listSuggestions } from './repositories/suggestions'
import { createTask, getTaskById, updateTask } from './repositories/tasks'
import { listEntriesByTracker } from './repositories/trackerEntries'
import { createTracker, getTrackerById, softDeleteTracker } from './repositories/trackers'
import { seedOwnerAndBullet } from './test-helpers'

// --- helpers to build suggestions of each shape ---

function taskCreateSuggestion(
  db: ReturnType<typeof createTestDb>['db'],
  ownerId: string,
  bulletId: string,
) {
  return createSuggestion(db, {
    owner_id: ownerId,
    source_bullet_id: bulletId,
    target_kind: 'task',
    operation: 'create',
    target_id: null,
    payload: {
      owner_id: ownerId,
      source_bullet_id: bulletId,
      title: 'Call dentist',
      notes: null,
      due_at: null,
      priority: null,
    },
    confidence: 0.95,
    tier: 'suggest',
    resolved_at: null,
  })
}

// === CREATE (provenance integrity) ===

test('applySuggestion CREATE task: persists + traces to the suggestion bullet', () => {
  const { db } = createTestDb()
  const { ownerId, bulletId } = seedOwnerAndBullet(db)
  const s = taskCreateSuggestion(db, ownerId, bulletId)

  const result = applySuggestion(db, s.id) as Task
  expect(result.title).toBe('Call dentist')
  expect(result.status).toBe('todo')
  // PROVENANCE INTEGRITY: created entity traces to the suggestion's bullet + owner.
  expect(result.source_bullet_id).toBe(bulletId)
  expect(result.owner_id).toBe(ownerId)
  expect(getTaskById(db, result.id)?.id).toBe(result.id)
})

test('applySuggestion CREATE activity + tracker also carry source_bullet_id', () => {
  const { db } = createTestDb()
  const { ownerId, bulletId } = seedOwnerAndBullet(db)

  const actSug = createSuggestion(db, {
    owner_id: ownerId,
    source_bullet_id: bulletId,
    target_kind: 'activity',
    operation: 'create',
    target_id: null,
    payload: {
      owner_id: ownerId,
      source_bullet_id: bulletId,
      name: 'Run',
      occurred_at: Date.now(),
      tracker_id: null,
      notes: null,
      quantity: 5,
      unit: 'km',
    },
    confidence: 0.9,
    tier: 'auto',
    resolved_at: null,
  })
  const act = applySuggestion(db, actSug.id) as Activity
  expect(act.source_bullet_id).toBe(bulletId)
  expect(getActivityById(db, act.id)?.name).toBe('Run')

  const trkSug = createSuggestion(db, {
    owner_id: ownerId,
    source_bullet_id: bulletId,
    target_kind: 'tracker',
    operation: 'create',
    target_id: null,
    payload: {
      owner_id: ownerId,
      source_bullet_id: bulletId,
      name: 'Mood',
      input_type: 'scale',
      config: { input_type: 'scale', min: 1, max: 5 },
    },
    confidence: 0.8,
    tier: 'suggest', // definitions are never 'auto'
    resolved_at: null,
  })
  const trk = applySuggestion(db, trkSug.id) as Tracker
  expect(trk.source_bullet_id).toBe(bulletId)
  expect(getTrackerById(db, trk.id)?.name).toBe('Mood')
})

// === APPEND (tracker_entry under a tracker) ===

test('applySuggestion APPEND: tracker_entry wired to target tracker', () => {
  const { db } = createTestDb()
  const { ownerId, bulletId } = seedOwnerAndBullet(db)
  const tracker = createTracker(db, {
    owner_id: ownerId,
    source_bullet_id: bulletId,
    name: 'Mood',
    input_type: 'scale',
    config: { input_type: 'scale', min: 1, max: 5 },
  })

  const s = createSuggestion(db, {
    owner_id: ownerId,
    source_bullet_id: bulletId,
    target_kind: 'tracker_entry',
    operation: 'append',
    target_id: tracker.id,
    payload: {
      owner_id: ownerId,
      source_bullet_id: bulletId,
      tracker_id: tracker.id,
      value: 4,
      logged_at: Date.now(),
    },
    confidence: 0.9,
    tier: 'auto',
    resolved_at: null,
  })

  const entry = applySuggestion(db, s.id) as TrackerEntry
  expect(entry.tracker_id).toBe(tracker.id) // wired from target_id
  expect(entry.value).toBe(4)
  expect(entry.source_bullet_id).toBe(bulletId)
  expect(listEntriesByTracker(db, tracker.id)).toHaveLength(1)
})

test('applySuggestion APPEND: rejects when target tracker missing or deleted', () => {
  const { db } = createTestDb()
  const { ownerId, bulletId } = seedOwnerAndBullet(db)

  // Missing tracker.
  const missing = createSuggestion(db, {
    owner_id: ownerId,
    source_bullet_id: bulletId,
    target_kind: 'tracker_entry',
    operation: 'append',
    target_id: '11111111-1111-4111-8111-111111111111',
    payload: {
      owner_id: ownerId,
      source_bullet_id: bulletId,
      tracker_id: '11111111-1111-4111-8111-111111111111',
      value: 1,
      logged_at: Date.now(),
    },
    confidence: 0.9,
    tier: 'auto',
    resolved_at: null,
  })
  expect(() => applySuggestion(db, missing.id)).toThrow(DbError)
  expect(() => applySuggestion(db, missing.id)).toThrow(/not found/i)

  // Deleted tracker.
  const tracker = createTracker(db, {
    owner_id: ownerId,
    source_bullet_id: bulletId,
    name: 'Mood',
    input_type: 'scale',
    config: { input_type: 'scale', min: 1, max: 5 },
  })
  softDeleteTracker(db, tracker.id)
  const onDeleted = createSuggestion(db, {
    owner_id: ownerId,
    source_bullet_id: bulletId,
    target_kind: 'tracker_entry',
    operation: 'append',
    target_id: tracker.id,
    payload: {
      owner_id: ownerId,
      source_bullet_id: bulletId,
      tracker_id: tracker.id,
      value: 1,
      logged_at: Date.now(),
    },
    confidence: 0.9,
    tier: 'auto',
    resolved_at: null,
  })
  expect(() => applySuggestion(db, onDeleted.id)).toThrow(/not active/i)
})

// === UPDATE (mutate a task) ===

test('applySuggestion UPDATE: marks a task done; rejects when target missing', () => {
  const { db } = createTestDb()
  const { ownerId, bulletId } = seedOwnerAndBullet(db)
  const task = createTask(db, {
    owner_id: ownerId,
    source_bullet_id: bulletId,
    title: 'Call dentist',
    notes: null,
    due_at: null,
    priority: null,
  })

  const s = createSuggestion(db, {
    owner_id: ownerId,
    source_bullet_id: bulletId,
    target_kind: 'task',
    operation: 'update',
    target_id: task.id,
    payload: {
      owner_id: ownerId,
      source_bullet_id: bulletId,
      title: 'Call dentist',
      status: 'done',
      notes: null,
      due_at: null,
      priority: null,
    },
    confidence: 0.9,
    tier: 'suggest',
    resolved_at: null,
  })

  const updated = applySuggestion(db, s.id) as Task
  expect(updated.id).toBe(task.id) // mutated in place, not a new row
  expect(updated.status).toBe('done')
  // owner/provenance/created_at preserved.
  expect(updated.owner_id).toBe(task.owner_id)
  expect(updated.created_at).toBe(task.created_at)

  const onMissing = createSuggestion(db, {
    owner_id: ownerId,
    source_bullet_id: bulletId,
    target_kind: 'task',
    operation: 'update',
    target_id: '22222222-2222-4222-8222-222222222222',
    payload: {
      owner_id: ownerId,
      source_bullet_id: bulletId,
      title: 't',
      status: 'done',
      notes: null,
      due_at: null,
      priority: null,
    },
    confidence: 0.9,
    tier: 'suggest',
    resolved_at: null,
  })
  expect(() => applySuggestion(db, onMissing.id)).toThrow(/not found/i)
})

test('applySuggestion UPDATE: a payload omitting status does NOT reset an in_progress task', () => {
  const { db } = createTestDb()
  const { ownerId, bulletId } = seedOwnerAndBullet(db)
  const task = createTask(db, {
    owner_id: ownerId,
    source_bullet_id: bulletId,
    title: 'Ship feature',
    notes: 'keep me',
    due_at: 1_700_000_000_000,
    priority: 'P2',
  })
  // Move the task off its starting state; this is what an omitted-status UPDATE must NOT reset.
  updateTask(db, task.id, { status: 'in_progress' })

  // A priority/title edit whose RAW payload OMITS `status`. `status` is the one task field
  // with a schema default ('todo'), so validation injects it into the parsed `data` even
  // though the user never proposed it. The patch must be built from the raw payload's keys —
  // if it were built from `data`, every UPDATE would write status and silently reset the task.
  const s = createSuggestion(db, {
    owner_id: ownerId,
    source_bullet_id: bulletId,
    target_kind: 'task',
    operation: 'update',
    target_id: task.id,
    payload: {
      owner_id: ownerId,
      source_bullet_id: bulletId,
      title: 'Ship feature (renamed)',
      notes: 'keep me',
      due_at: 1_700_000_000_000,
      priority: 'P1',
      // status deliberately omitted
    },
    confidence: 0.9,
    tier: 'suggest',
    resolved_at: null,
  })

  const updated = applySuggestion(db, s.id) as Task
  expect(updated.title).toBe('Ship feature (renamed)') // proposed → applied
  expect(updated.priority).toBe('P1') // proposed → applied
  expect(updated.status).toBe('in_progress') // NOT reset to 'todo' by the insert-schema default
})

test('applySuggestion UPDATE: omitting a mutable field leaves the live value untouched', () => {
  const { db } = createTestDb()
  const { ownerId, bulletId } = seedOwnerAndBullet(db)
  const task = createTask(db, {
    owner_id: ownerId,
    source_bullet_id: bulletId,
    title: 'Original title',
    notes: 'original notes',
    due_at: 1_700_000_000_000,
    priority: 'P2',
  })
  updateTask(db, task.id, { status: 'done' })

  // A status-only transition (the canonical "mark done" UPDATE). title/notes/due_at/priority
  // happen to be carried in the payload for schema validity, but assert specifically that the
  // DONE status reached the row and the title the user kept was preserved.
  const s = createSuggestion(db, {
    owner_id: ownerId,
    source_bullet_id: bulletId,
    target_kind: 'task',
    operation: 'update',
    target_id: task.id,
    payload: {
      owner_id: ownerId,
      source_bullet_id: bulletId,
      title: 'Original title',
      status: 'in_progress',
      notes: 'original notes',
      due_at: 1_700_000_000_000,
      priority: 'P2',
    },
    confidence: 0.9,
    tier: 'suggest',
    resolved_at: null,
  })

  const updated = applySuggestion(db, s.id) as Task
  expect(updated.status).toBe('in_progress') // explicit status IS written when present
  expect(updated.title).toBe('Original title')
})

// === accept / reject / edit transitions ===

test('acceptSuggestion: applies + sets status accepted/resolved_at; guards double-resolve', () => {
  const { db } = createTestDb()
  const { ownerId, bulletId } = seedOwnerAndBullet(db)
  const s = taskCreateSuggestion(db, ownerId, bulletId)

  const { suggestion, result } = acceptSuggestion(db, s.id)
  expect(suggestion.status).toBe('accepted')
  expect(suggestion.resolved_at).toBeTypeOf('number')
  expect((result as Task).title).toBe('Call dentist')

  // Double-resolve is rejected.
  expect(() => acceptSuggestion(db, s.id)).toThrow(/already resolved/i)
  expect(() => rejectSuggestion(db, s.id)).toThrow(/already resolved/i)
})

test('rejectSuggestion: marks rejected, creates NO entity', () => {
  const { db } = createTestDb()
  const { ownerId, bulletId } = seedOwnerAndBullet(db)
  const s = taskCreateSuggestion(db, ownerId, bulletId)

  const rejected = rejectSuggestion(db, s.id)
  expect(rejected.status).toBe('rejected')
  expect(rejected.resolved_at).toBeTypeOf('number')
  // No task was created.
  expect(getTaskById(db, s.id)).toBeUndefined()
  // No active task exists for the owner.
  const remaining = listSuggestions(db, ownerId).find((x) => x.id === s.id)
  expect(remaining?.status).toBe('rejected')
})

test('editSuggestion: applies the EDITED payload, marks status edited', () => {
  const { db } = createTestDb()
  const { ownerId, bulletId } = seedOwnerAndBullet(db)
  const s = taskCreateSuggestion(db, ownerId, bulletId)

  const { suggestion, result } = editSuggestion(db, s.id, {
    owner_id: ownerId,
    source_bullet_id: bulletId,
    title: 'Call dentist URGENT',
    notes: 'before noon',
    due_at: null,
    priority: 'P1',
  })

  expect(suggestion.status).toBe('edited')
  expect(suggestion.resolved_at).toBeTypeOf('number')
  // The applied entity reflects the EDITED payload, not the original.
  expect((result as Task).title).toBe('Call dentist URGENT')
  expect((result as Task).priority).toBe('P1')
  expect(getSuggestionById(db, s.id)?.payload.title).toBe('Call dentist URGENT')
})

// === re-validation ===

test('applySuggestion/accept rejects a payload that violates the kind schema', () => {
  const { db } = createTestDb()
  const { ownerId, bulletId } = seedOwnerAndBullet(db)
  // Empty title — invalid per the task insert schema.
  const s = createSuggestion(db, {
    owner_id: ownerId,
    source_bullet_id: bulletId,
    target_kind: 'task',
    operation: 'create',
    target_id: null,
    payload: {
      owner_id: ownerId,
      source_bullet_id: bulletId,
      title: '',
      notes: null,
      due_at: null,
      priority: null,
    },
    confidence: 0.9,
    tier: 'suggest',
    resolved_at: null,
  })
  expect(() => applySuggestion(db, s.id)).toThrow(/invalid/i)
  expect(() => acceptSuggestion(db, s.id)).toThrow(/invalid/i)
  // Failed accept must NOT have resolved the suggestion.
  expect(getSuggestionById(db, s.id)?.status).toBe('pending')
})

test('editSuggestion rejects an invalid edited payload before mutating', () => {
  const { db } = createTestDb()
  const { ownerId, bulletId } = seedOwnerAndBullet(db)
  const s = taskCreateSuggestion(db, ownerId, bulletId)
  expect(() =>
    editSuggestion(db, s.id, {
      owner_id: ownerId,
      source_bullet_id: bulletId,
      title: '',
      notes: null,
      due_at: null,
      priority: null,
    }),
  ).toThrow(/invalid/i)
  // Still pending — the failed edit did not resolve it.
  expect(getSuggestionById(db, s.id)?.status).toBe('pending')
})

test('editSuggestion: a structurally-valid edit whose append target is gone leaves it pending', () => {
  const { db } = createTestDb()
  const { ownerId, bulletId } = seedOwnerAndBullet(db)
  const tracker = createTracker(db, {
    owner_id: ownerId,
    source_bullet_id: bulletId,
    name: 'Mood',
    input_type: 'scale',
    config: { input_type: 'scale', min: 1, max: 5 },
  })

  // An append suggestion targeting the (currently active) tracker.
  const s = createSuggestion(db, {
    owner_id: ownerId,
    source_bullet_id: bulletId,
    target_kind: 'tracker_entry',
    operation: 'append',
    target_id: tracker.id,
    payload: {
      owner_id: ownerId,
      source_bullet_id: bulletId,
      tracker_id: tracker.id,
      value: 3,
      logged_at: Date.now(),
    },
    confidence: 0.9,
    tier: 'auto',
    resolved_at: null,
  })

  // The target tracker is deleted/mutated AFTER extraction. The edited payload is fully
  // STRUCTURALLY valid; only the live-state guard inside applySuggestion fails.
  softDeleteTracker(db, tracker.id)

  expect(() =>
    editSuggestion(db, s.id, {
      owner_id: ownerId,
      source_bullet_id: bulletId,
      tracker_id: tracker.id,
      value: 5, // edited value
      logged_at: Date.now(),
    }),
  ).toThrow(/not active/i)

  // The failed apply must have ROLLED BACK the status/payload write: still pending and
  // re-editable, with no orphaned entry, no terminal 'edited' status, no resolved_at.
  const after = getSuggestionById(db, s.id)
  expect(after?.status).toBe('pending')
  expect(after?.resolved_at).toBeNull()
  expect(after?.payload.value).toBe(3) // original payload preserved, not the edited 5
  expect(listEntriesByTracker(db, tracker.id)).toHaveLength(0) // no entry created
})

test('acceptSuggestion: a failed apply rolls back, leaving the suggestion pending (atomic)', () => {
  const { db } = createTestDb()
  const { ownerId, bulletId } = seedOwnerAndBullet(db)
  const tracker = createTracker(db, {
    owner_id: ownerId,
    source_bullet_id: bulletId,
    name: 'Mood',
    input_type: 'scale',
    config: { input_type: 'scale', min: 1, max: 5 },
  })
  const s = createSuggestion(db, {
    owner_id: ownerId,
    source_bullet_id: bulletId,
    target_kind: 'tracker_entry',
    operation: 'append',
    target_id: tracker.id,
    payload: {
      owner_id: ownerId,
      source_bullet_id: bulletId,
      tracker_id: tracker.id,
      value: 2,
      logged_at: Date.now(),
    },
    confidence: 0.9,
    tier: 'auto',
    resolved_at: null,
  })

  // Target deleted after extraction → apply's live-state guard throws.
  softDeleteTracker(db, tracker.id)

  expect(() => acceptSuggestion(db, s.id)).toThrow(/not active/i)
  const after = getSuggestionById(db, s.id)
  expect(after?.status).toBe('pending')
  expect(after?.resolved_at).toBeNull()
  expect(listEntriesByTracker(db, tracker.id)).toHaveLength(0)
})
