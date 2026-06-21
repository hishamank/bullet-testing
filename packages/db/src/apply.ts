/**
 * The apply / commit engine — the heart of @bullet/db.
 *
 * A Suggestion is the agent's proposed change. `applySuggestion` executes it against CURRENT
 * state, RE-VALIDATING the payload (suggestions persist and current state may have moved, so
 * we never trust the payload that was valid at extraction time). `accept`/`reject`/`edit`
 * wrap apply with the status transitions (CLAUDE.md §4.3, §4.7). `softDelete` implements the
 * three deletion modes (§4.6).
 *
 * Everything here is a plain exported function — the future tRPC layer is a thin wrapper.
 */

import {
  type Activity,
  type Suggestion,
  type SuggestionPayload,
  type Task,
  type Tracker,
  type TrackerEntry,
  validateSuggestionPayload,
} from '@bullet/core'
import type { Db } from './client'
import { DbError } from './errors'
import {
  createActivity,
  listActivitiesBySourceBullet,
  softDeleteActivity,
} from './repositories/activities'
import { softDeleteBullet } from './repositories/bullets'
import { now } from './repositories/shared'
import {
  getSuggestionById,
  listSuggestionsByBullet,
  softDeleteSuggestion,
  updateSuggestion,
} from './repositories/suggestions'
import {
  createTask,
  getTaskById,
  listTasksBySourceBullet,
  softDeleteTask,
  updateTask,
} from './repositories/tasks'
import {
  createTrackerEntry,
  listTrackerEntriesBySourceBullet,
  softDeleteTrackerEntry,
} from './repositories/trackerEntries'
import {
  createTracker,
  getTrackerById,
  listTrackersBySourceBullet,
  softDeleteTracker,
} from './repositories/trackers'

/** The entity produced or mutated by applying a suggestion. */
export type ApplyResult = Task | Tracker | TrackerEntry | Activity

interface Provenance {
  owner_id: string
  source_bullet_id: string
}

/** Resolve a suggestion argument that may be either the row or its id. */
function resolveSuggestion(db: Db, suggestionOrId: Suggestion | string): Suggestion {
  const suggestion =
    typeof suggestionOrId === 'string' ? getSuggestionById(db, suggestionOrId) : suggestionOrId
  if (!suggestion) {
    throw new DbError('NOT_FOUND', `Suggestion not found: ${String(suggestionOrId)}`)
  }
  return suggestion
}

/**
 * Validate `payload` against the target kind's INSERT schema (re-validation), throwing a
 * typed `DbError` on failure. Returns the parsed payload data.
 */
function validatePayloadOrThrow(
  target_kind: Suggestion['target_kind'],
  payload: SuggestionPayload,
): Record<string, unknown> {
  const res = validateSuggestionPayload(target_kind, payload)
  if (!res.success) {
    throw new DbError(
      'INVALID_PAYLOAD',
      `Suggestion payload is invalid for target_kind '${target_kind}'`,
      res.error.flatten(),
    )
  }
  return res.data as Record<string, unknown>
}

/**
 * Execute a suggestion against current state.
 *
 *  1. Load it; require state='active' AND status='pending'.
 *  2. Re-validate `payload` against the target kind's schema.
 *  3. Dispatch on `operation`: create | append | update.
 *
 * Provenance: created rows always carry `owner_id`/`source_bullet_id` from the suggestion.
 * Does NOT change the suggestion's status — that is the caller's job (accept/edit).
 */
export function applySuggestion(db: Db, suggestionOrId: Suggestion | string): ApplyResult {
  const suggestion = resolveSuggestion(db, suggestionOrId)

  // (1) Guards — only an active, pending suggestion may be applied.
  if (suggestion.state !== 'active') {
    throw new DbError(
      'INVALID_STATE',
      `Cannot apply a deleted suggestion (${suggestion.id}); state='${suggestion.state}'`,
    )
  }
  if (suggestion.status !== 'pending') {
    throw new DbError(
      'INVALID_STATE',
      `Cannot apply suggestion ${suggestion.id}: status='${suggestion.status}' (only 'pending' is applyable)`,
    )
  }

  // (2) Re-validate the payload against the live schema for this kind.
  const data = validatePayloadOrThrow(suggestion.target_kind, suggestion.payload)

  // (3) Dispatch on operation. Provenance is forced from the suggestion, never trusted from
  // the payload.
  const provenance: Provenance = {
    owner_id: suggestion.owner_id,
    source_bullet_id: suggestion.source_bullet_id,
  }

  switch (suggestion.operation) {
    case 'create':
      return applyCreate(db, suggestion, data, provenance)
    case 'append':
      return applyAppend(db, suggestion, data, provenance)
    case 'update':
      return applyUpdate(db, suggestion, data)
    default: {
      // Exhaustiveness guard; `operation` is a closed union.
      const never: never = suggestion.operation
      throw new DbError('UNSUPPORTED_OPERATION', `Unknown operation: ${String(never)}`)
    }
  }
}

/** `create`: mint a NEW row of `target_kind`, forcing owner/provenance from the suggestion. */
function applyCreate(
  db: Db,
  suggestion: Suggestion,
  data: Record<string, unknown>,
  provenance: Provenance,
): ApplyResult {
  // Defensive: core enforces create ⇒ target_id null; re-check here.
  if (suggestion.target_id !== null) {
    throw new DbError(
      'INVALID_STATE',
      `operation 'create' must have target_id null (got '${suggestion.target_id}')`,
    )
  }

  const input = { ...data, ...provenance }
  switch (suggestion.target_kind) {
    case 'task':
      return createTask(db, input)
    case 'tracker':
      return createTracker(db, input)
    case 'activity':
      return createActivity(db, input)
    case 'tracker_entry':
      // A bare tracker_entry create needs a tracker_id in the payload; verify the tracker.
      return createEntryVerifyingTracker(db, input)
    default: {
      const never: never = suggestion.target_kind
      throw new DbError('UNSUPPORTED_OPERATION', `Cannot create target_kind: ${String(never)}`)
    }
  }
}

/**
 * `append`: add a child RECORD to the definition identified by `target_id`.
 *
 * v1 supported case: `target_kind='tracker_entry'`, `target_id=<tracker id>` → create a
 * tracker_entry with `tracker_id=target_id`. The target tracker must exist AND be active.
 * Other append kinds are not supported in v1 (throw a clear error) — the design is extensible.
 */
function applyAppend(
  db: Db,
  suggestion: Suggestion,
  data: Record<string, unknown>,
  provenance: Provenance,
): ApplyResult {
  if (suggestion.target_id === null) {
    throw new DbError(
      'INVALID_STATE',
      `operation 'append' requires a non-null target_id (the definition being appended to)`,
    )
  }

  if (suggestion.target_kind !== 'tracker_entry') {
    throw new DbError(
      'UNSUPPORTED_OPERATION',
      `append is only supported for target_kind 'tracker_entry' in v1 (got '${suggestion.target_kind}')`,
    )
  }

  const tracker = getTrackerById(db, suggestion.target_id)
  if (!tracker) {
    throw new DbError('NOT_FOUND', `append target tracker not found: ${suggestion.target_id}`)
  }
  if (tracker.state !== 'active') {
    throw new DbError(
      'INVALID_STATE',
      `append target tracker ${tracker.id} is not active (state='${tracker.state}')`,
    )
  }

  // TODO(Task 3, packages/agent): validating the entry `value` against the PARENT tracker's
  // `input_type` (e.g. multi_select ⇒ string[], scale ⇒ number) is intentionally deferred to
  // the agent resolve layer, which has the tracker in hand. Here we accept the structural
  // TrackerEntryValue union only — the same deferral is documented in
  // packages/core/src/entities/trackerEntry.ts (trackerEntryValueSchema).
  // Wire tracker_id from the target; provenance overrides any payload-supplied owner/bullet.
  return createTrackerEntry(db, {
    ...data,
    ...provenance,
    tracker_id: suggestion.target_id,
  })
}

/**
 * `update`: MUTATE the existing entity of `target_kind` identified by `target_id`. Verify it
 * exists and is active; apply the payload as a partial update of MUTABLE fields only (never
 * id/owner/provenance/created_at); bump updated_at.
 *
 * v1 supports updating Tasks (e.g. mark done). Other update kinds are extensible later.
 */
function applyUpdate(db: Db, suggestion: Suggestion, data: Record<string, unknown>): ApplyResult {
  if (suggestion.target_id === null) {
    throw new DbError(
      'INVALID_STATE',
      `operation 'update' requires a non-null target_id (the entity being changed)`,
    )
  }

  if (suggestion.target_kind !== 'task') {
    throw new DbError(
      'UNSUPPORTED_OPERATION',
      `update is only supported for target_kind 'task' in v1 (got '${suggestion.target_kind}')`,
    )
  }

  const existing = getTaskById(db, suggestion.target_id)
  if (!existing) {
    throw new DbError('NOT_FOUND', `update target task not found: ${suggestion.target_id}`)
  }
  if (existing.state !== 'active') {
    throw new DbError(
      'INVALID_STATE',
      `update target task ${existing.id} is not active (state='${existing.state}')`,
    )
  }

  // Only mutable task fields the suggestion ACTUALLY proposed are applied — never
  // id/owner/provenance/created. Key presence is read from the suggestion's RAW payload, NOT
  // from `data`: `data` is the INSERT-schema parse, and `taskInsertSchema` defaults
  // `status` to 'todo', so `'status' in data` is always true. Picking from `data` would write
  // status on every update and silently reset an in_progress/done task whose payload omitted
  // it. The validated `data` is still used for the VALUES (coercion/normalisation).
  const rawPayload = suggestion.payload
  const patch: Record<string, unknown> = {}
  for (const key of ['status', 'title', 'notes', 'due_at', 'priority'] as const) {
    if (key in rawPayload) patch[key] = data[key]
  }

  const updated = updateTask(db, existing.id, patch)
  if (!updated) {
    throw new DbError('NOT_FOUND', `update target task vanished mid-update: ${existing.id}`)
  }
  return updated
}

/** Verify a tracker exists/active for a direct tracker_entry create (used by `create`). */
function createEntryVerifyingTracker(db: Db, input: Record<string, unknown>): TrackerEntry {
  const trackerId = input.tracker_id
  if (typeof trackerId !== 'string') {
    throw new DbError(
      'INVALID_PAYLOAD',
      `tracker_entry create requires a tracker_id in the payload`,
    )
  }
  const tracker = getTrackerById(db, trackerId)
  if (tracker?.state !== 'active') {
    throw new DbError('NOT_FOUND', `tracker_entry target tracker not found/active: ${trackerId}`)
  }
  return createTrackerEntry(db, input)
}

/** The bundle a status-changing operation returns. */
export interface ResolveResult {
  suggestion: Suggestion
  result: ApplyResult
}

/**
 * Accept a suggestion: guard it is pending, apply it, then mark `status='accepted'` and stamp
 * `resolved_at`. Returns the updated suggestion and the applied entity.
 */
export function acceptSuggestion(db: Db, id: string): ResolveResult {
  const suggestion = resolveSuggestion(db, id)
  guardPending(suggestion)

  // Apply + status transition are ONE atomic unit: a thrown apply (e.g. its live-state guards
  // fail) rolls back, leaving the suggestion 'pending' with no orphaned entity; a crash
  // between the two writes can never leave the entity created while the suggestion stays
  // pending (which would let a re-accept duplicate it).
  return db.transaction((tx) => {
    const result = applySuggestion(tx, suggestion)
    const updated = updateSuggestion(tx, suggestion.id, {
      status: 'accepted',
      resolved_at: now(),
    })
    return { suggestion: updated ?? suggestion, result }
  })
}

/**
 * Reject a suggestion: guard it is pending, mark `status='rejected'`, stamp `resolved_at`.
 * Does NOT apply anything (no entity is created/mutated). Returns the updated suggestion.
 */
export function rejectSuggestion(db: Db, id: string): Suggestion {
  const suggestion = resolveSuggestion(db, id)
  guardPending(suggestion)

  const updated = updateSuggestion(db, suggestion.id, {
    status: 'rejected',
    resolved_at: now(),
  })
  return updated ?? suggestion
}

/**
 * Edit a suggestion (accept-with-modifications, CLAUDE.md §4.7): validate `newPayload` for the
 * kind/operation, persist it with `status='edited'` (terminal) + `resolved_at`, then apply the
 * edited payload. Returns the updated suggestion and the applied entity.
 */
export function editSuggestion(db: Db, id: string, newPayload: SuggestionPayload): ResolveResult {
  const suggestion = resolveSuggestion(db, id)
  guardPending(suggestion)

  // Validate the edited payload STRUCTURALLY up-front (clear error before any write).
  validatePayloadOrThrow(suggestion.target_kind, newPayload)

  // Apply + status transition are ONE atomic unit, and — mirroring acceptSuggestion — we
  // APPLY FIRST, then persist 'edited'. applySuggestion re-runs the live-state guards
  // (append/update target must exist + be active) against the edited payload; if any throws,
  // the transaction rolls back and the row stays 'pending' (re-editable), with no entity
  // created. We apply from an in-memory snapshot that still reads status='pending' (so
  // applySuggestion's pending-guard passes) carrying the edited payload; only the persisted
  // row reaches the terminal 'edited' status, and only if the apply succeeded.
  return db.transaction((tx) => {
    const applyInput: Suggestion = {
      ...suggestion,
      payload: newPayload,
      status: 'pending',
    }
    const result = applySuggestion(tx, applyInput)

    const edited = updateSuggestion(tx, suggestion.id, {
      payload: newPayload,
      status: 'edited',
      resolved_at: now(),
    })

    return { suggestion: edited ?? suggestion, result }
  })
}

/** Throw unless the suggestion is active and pending (prevents double-resolution). */
function guardPending(suggestion: Suggestion): void {
  if (suggestion.state !== 'active') {
    throw new DbError(
      'INVALID_STATE',
      `Suggestion ${suggestion.id} is deleted (state='${suggestion.state}')`,
    )
  }
  if (suggestion.status !== 'pending') {
    throw new DbError(
      'INVALID_STATE',
      `Suggestion ${suggestion.id} is already resolved (status='${suggestion.status}')`,
    )
  }
}

/** The three deletion modes a delete dialog offers (CLAUDE.md §4.6). */
export type DeleteMode = 'cancel' | 'cascade' | 'keep'

/** What a soft-delete affected — the bullet plus, for cascade, the traced extractions. */
export interface SoftDeleteResult {
  mode: DeleteMode
  bulletId: string
  /** True if the bullet itself was soft-deleted (false only for 'cancel'). */
  bulletDeleted: boolean
  /** Ids of the extracted rows soft-deleted by a cascade (empty for 'keep'/'cancel'). */
  cascadedIds: string[]
}

/**
 * Soft-delete a bullet per the chosen mode (CLAUDE.md §4.6):
 *
 *  - 'cancel'  → no-op.
 *  - 'cascade' → soft-delete the bullet AND every active row across tasks/trackers/
 *                tracker_entries/activities/suggestions whose source_bullet_id === bulletId
 *                (direct provenance).
 *  - 'keep'    → soft-delete ONLY the bullet; its extractions survive (their source_bullet_id
 *                still points at the now-deleted bullet).
 */
export function softDelete(db: Db, bulletId: string, mode: DeleteMode): SoftDeleteResult {
  if (mode === 'cancel') {
    return { mode, bulletId, bulletDeleted: false, cascadedIds: [] }
  }

  const bullet = softDeleteBullet(db, bulletId)
  if (!bullet) {
    throw new DbError('NOT_FOUND', `Bullet not found: ${bulletId}`)
  }

  if (mode === 'keep') {
    return { mode, bulletId, bulletDeleted: true, cascadedIds: [] }
  }

  // mode === 'cascade': soft-delete every active row traced directly to this bullet. The
  // `…BySourceBullet` helpers push the `source_bullet_id = ? AND state = 'active'` predicate to
  // SQL (indexed on source_bullet_id), so this is O(rows traced to THIS bullet), not O(all of
  // the owner's rows). Rows traced to a DIFFERENT bullet are never returned, so they stay
  // untouched.
  const cascadedIds: string[] = []

  for (const task of listTasksBySourceBullet(db, bulletId)) {
    softDeleteTask(db, task.id)
    cascadedIds.push(task.id)
  }
  for (const tracker of listTrackersBySourceBullet(db, bulletId)) {
    softDeleteTracker(db, tracker.id)
    cascadedIds.push(tracker.id)
  }
  for (const entry of listTrackerEntriesBySourceBullet(db, bulletId)) {
    softDeleteTrackerEntry(db, entry.id)
    cascadedIds.push(entry.id)
  }
  for (const activity of listActivitiesBySourceBullet(db, bulletId)) {
    softDeleteActivity(db, activity.id)
    cascadedIds.push(activity.id)
  }
  for (const suggestion of listSuggestionsByBullet(db, bulletId)) {
    softDeleteSuggestion(db, suggestion.id)
    cascadedIds.push(suggestion.id)
  }

  return { mode, bulletId, bulletDeleted: true, cascadedIds }
}
