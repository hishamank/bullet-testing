/**
 * resolveCandidates — the create-vs-append brain (CLAUDE.md §4.4 + §4.5).
 *
 * Each LLM Candidate is routed to a `ResolvedSuggestion`: a Suggestion INSERT DRAFT
 * (`{ target_kind, operation, target_id, payload, confidence, tier }`). `owner_id` and
 * `source_bullet_id` are added at PERSIST time (queue/process.ts), so the resolver stays pure
 * and independent of the bullet/owner.
 *
 * Routing by orientation:
 *  - happened:
 *      • strong tracker match  → append a tracker_entry under that tracker.
 *      • strong open-task match → update that task to status 'done' ("mutate an instance").
 *      • otherwise             → create an activity (linked to a confident tracker, else
 *                                UNLINKED — "activity-first", never drop the data).
 *  - future_oneoff   → create a task.
 *  - future_recurring → create a tracker DEFINITION.
 *  - durable_fact    → SKIPPED (Note is out of v1 scope) — counted, never persisted.
 *
 * Confidence: for append/update we COMBINE the model confidence with the fuse match score
 * (`combine`) so the final number is explainable; for plain creates we use the model
 * confidence directly.
 */

import type {
  SuggestionOperation,
  SuggestionPayload,
  SuggestionTier,
  TargetKind,
  TrackerInputType,
} from '@bullet/core'
import type { AgentConfig } from '../config'
import type { Candidate } from '../extraction/schema'
import type { ExtractionSnapshot, SnapshotTask } from '../extraction/snapshot'
import { type Match, matchOpenTask, matchTracker } from './match'
import { assignTier } from './tier'

/** A Suggestion INSERT draft — owner_id/source_bullet_id are added when persisting. */
export interface ResolvedSuggestion {
  target_kind: TargetKind
  operation: SuggestionOperation
  target_id: string | null
  payload: SuggestionPayload
  confidence: number
  tier: SuggestionTier
}

/**
 * The outcome of resolving a batch: the drafts to persist plus a count of candidates SKIPPED
 * (durable_fact / out-of-scope) so the data is never silently lost (we log/count it).
 */
export interface ResolveOutcome {
  suggestions: ResolvedSuggestion[]
  /** Count of candidates intentionally dropped (currently: durable_fact notes). */
  skipped: number
}

/**
 * Turn a {@link ResolvedSuggestion} draft into a full Suggestion INSERT, attaching provenance.
 *
 * The apply/commit engine RE-VALIDATES the payload against the target kind's INSERT schema, and
 * that schema requires `owner_id` + `source_bullet_id` (and a nullable `source_bullet_id`) to be
 * PRESENT on the payload — so we inject provenance into BOTH the suggestion envelope AND the
 * payload. The apply engine then FORCES provenance from the suggestion anyway, so the two can
 * never disagree. `resolved_at` is null (a fresh suggestion is unresolved; the field is
 * required-but-nullable).
 */
export function withProvenance(
  draft: ResolvedSuggestion,
  ownerId: string,
  sourceBulletId: string,
): Record<string, unknown> {
  return {
    target_kind: draft.target_kind,
    operation: draft.operation,
    target_id: draft.target_id,
    confidence: draft.confidence,
    tier: draft.tier,
    owner_id: ownerId,
    source_bullet_id: sourceBulletId,
    resolved_at: null,
    payload: {
      ...draft.payload,
      owner_id: ownerId,
      source_bullet_id: sourceBulletId,
    },
  }
}

/**
 * Above this normalised fuse score (1 = perfect) we treat a match as a CONFIDENT link and
 * append/update against it rather than create a new entity.
 */
const MATCH_LINK_THRESHOLD = 0.6

/** Combine model confidence with a match score into one explainable number (their mean). */
function combine(modelConfidence: number, matchScore: number): number {
  return (modelConfidence + matchScore) / 2
}

/** Clamp to [0, 1] (defensive — the model is constrained but we never trust it blindly). */
function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

/** A finite epoch-ms timestamp for record/occurrence fields when the model omits one. */
function nowMs(): number {
  return Date.now()
}

/**
 * Resolve a batch of candidates against the snapshot into Suggestion INSERT drafts.
 * Pure: no DB, no IO — just routing + matching + tier assignment.
 */
export function resolveCandidates(
  candidates: Candidate[],
  snapshot: ExtractionSnapshot,
  config: AgentConfig,
): ResolveOutcome {
  const suggestions: ResolvedSuggestion[] = []
  let skipped = 0

  for (const candidate of candidates) {
    switch (candidate.orientation) {
      case 'happened': {
        const resolved = resolveHappened(candidate, snapshot, config)
        suggestions.push(resolved)
        break
      }
      case 'future_oneoff': {
        suggestions.push(resolveFutureOneoff(candidate, config))
        break
      }
      case 'future_recurring': {
        suggestions.push(resolveFutureRecurring(candidate, config))
        break
      }
      case 'durable_fact': {
        // Note is out of v1 scope — emit NOTHING but count it (never lose track).
        skipped += 1
        break
      }
      default: {
        // Exhaustiveness guard; orientation is a closed union.
        const never: never = candidate.orientation
        throw new Error(`Unknown orientation: ${String(never)}`)
      }
    }
  }

  return { suggestions, skipped }
}

/** Route a 'happened' candidate: append a tracker entry, mark a task done, or create activity. */
function resolveHappened(
  candidate: Candidate,
  snapshot: ExtractionSnapshot,
  config: AgentConfig,
): ResolvedSuggestion {
  const trackerHit = matchTracker(candidate, snapshot.trackers)
  const taskHit = matchOpenTask(candidate, snapshot.openTasks)

  // Prefer whichever existing thing matches more strongly (and clears the link threshold).
  const trackerScore = trackerHit?.score ?? 0
  const taskScore = taskHit?.score ?? 0

  // A quantified reading + strong tracker match → append a tracker_entry.
  if (trackerHit && trackerScore >= MATCH_LINK_THRESHOLD && trackerScore >= taskScore) {
    return appendTrackerEntry(candidate, trackerHit, config)
  }

  // A strong OPEN-TASK match → mark that task done (mutate an existing instance).
  if (taskHit && taskScore >= MATCH_LINK_THRESHOLD) {
    return markTaskDone(candidate, taskHit, config)
  }

  // Otherwise an action with no confident match → create an activity. If there is a tracker
  // match that is present-but-weak we still leave it UNLINKED (activity-first; never guess a
  // link we are not confident about).
  return createActivity(candidate, trackerHit, config)
}

/** happened + strong tracker → append a tracker_entry under the matched tracker. */
function appendTrackerEntry(
  candidate: Candidate,
  trackerHit: Match<{ id: string; name: string; input_type: TrackerInputType }>,
  config: AgentConfig,
): ResolvedSuggestion {
  const confidence = clamp01(combine(candidate.confidence, trackerHit.score))
  const value = coerceEntryValue(candidate.fields, trackerHit.item.input_type)
  const payload: SuggestionPayload = {
    // `tracker_id` is part of the tracker_entry INSERT schema, so the apply engine's
    // re-validation (which runs BEFORE it wires tracker_id from target_id) requires it present.
    // The apply engine overrides it from target_id, so the two always agree.
    tracker_id: trackerHit.item.id,
    value,
    logged_at: timestampField(candidate.fields, ['logged_at', 'occurred_at'], nowMs()),
  }
  return {
    target_kind: 'tracker_entry',
    operation: 'append',
    target_id: trackerHit.item.id,
    payload,
    confidence,
    // tracker_entry append is a record — eligible for auto when confident.
    tier: assignTier('tracker_entry', 'append', confidence, config),
  }
}

/** happened + strong open task → update that task to status 'done'. */
function markTaskDone(
  candidate: Candidate,
  taskHit: Match<SnapshotTask>,
  config: AgentConfig,
): ResolvedSuggestion {
  const confidence = clamp01(combine(candidate.confidence, taskHit.score))
  const task = taskHit.item
  // The apply engine RE-VALIDATES this payload against the FULL task INSERT schema
  // (taskInsertSchema requires title + the keys notes/due_at/priority present), so a bare
  // `{ status: 'done' }` would fail INVALID_PAYLOAD and the mark-done could never be applied.
  // We carry the matched task's CURRENT field values unchanged alongside the only mutation we
  // intend (status → 'done'); `applyUpdate` patches every key the raw payload proposes, so
  // re-supplying the existing values is a no-op on those fields while satisfying validation.
  const payload: SuggestionPayload = {
    title: task.title,
    notes: task.notes,
    due_at: task.due_at,
    priority: task.priority,
    status: 'done',
  }
  return {
    target_kind: 'task',
    operation: 'update',
    target_id: task.id,
    payload,
    confidence,
    // A task mark-done is an instance update — eligible for auto when confident.
    tier: assignTier('task', 'update', confidence, config),
  }
}

/** happened + no confident match → create an activity (linked only if confident, else unlinked). */
function createActivity(
  candidate: Candidate,
  trackerHit: Match<{ id: string; name: string; input_type: TrackerInputType }> | undefined,
  config: AgentConfig,
): ResolvedSuggestion {
  // Only link if the tracker match is confident; otherwise leave unlinked (activity-first).
  const linked = trackerHit && trackerHit.score >= MATCH_LINK_THRESHOLD ? trackerHit : undefined
  const name = stringField(candidate.fields, ['name', 'title'], candidate.text)
  const payload: SuggestionPayload = {
    name,
    occurred_at: timestampField(candidate.fields, ['occurred_at', 'logged_at'], nowMs()),
    tracker_id: linked ? linked.item.id : null,
    notes: stringFieldOrNull(candidate.fields, ['notes']),
    quantity: numberFieldOrNull(candidate.fields, ['quantity', 'value']),
    unit: stringFieldOrNull(candidate.fields, ['unit']),
  }
  const confidence = clamp01(candidate.confidence)
  return {
    target_kind: 'activity',
    operation: 'create',
    target_id: null,
    payload,
    confidence,
    tier: assignTier('activity', 'create', confidence, config),
  }
}

/** future_oneoff → create a task. */
function resolveFutureOneoff(candidate: Candidate, config: AgentConfig): ResolvedSuggestion {
  const title = stringField(candidate.fields, ['title', 'name'], candidate.text)
  const payload: SuggestionPayload = {
    title,
    due_at: numberFieldOrNull(candidate.fields, ['due_at']),
    priority: priorityFieldOrNull(candidate.fields),
    notes: stringFieldOrNull(candidate.fields, ['notes']),
    status: 'todo',
  }
  const confidence = clamp01(candidate.confidence)
  return {
    target_kind: 'task',
    operation: 'create',
    target_id: null,
    payload,
    confidence,
    tier: assignTier('task', 'create', confidence, config),
  }
}

/** future_recurring → create a tracker DEFINITION (never auto). */
function resolveFutureRecurring(candidate: Candidate, config: AgentConfig): ResolvedSuggestion {
  const name = stringField(candidate.fields, ['name', 'title'], candidate.text)
  const inputType = inputTypeField(candidate.fields)
  const payload: SuggestionPayload = {
    name,
    input_type: inputType,
    config: defaultConfigFor(inputType, candidate.fields),
  }
  const confidence = clamp01(candidate.confidence)
  return {
    target_kind: 'tracker',
    operation: 'create',
    target_id: null,
    payload,
    confidence,
    tier: assignTier('tracker', 'create', confidence, config),
  }
}

// --- field coercion helpers (the model's `fields` are loose; normalise defensively) ---

/** Read a string field by trying each key in order, falling back to `fallback`. */
function stringField(fields: Record<string, unknown>, keys: string[], fallback: string): string {
  for (const k of keys) {
    const v = fields[k]
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  return fallback
}

/** Read an optional string field; null when absent/empty. */
function stringFieldOrNull(fields: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = fields[k]
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  return null
}

/** Read an optional number field; null when absent/non-numeric. */
function numberFieldOrNull(fields: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = fields[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return null
}

/** Read an epoch-ms timestamp field; fall back to `fallback` when absent/invalid. */
function timestampField(fields: Record<string, unknown>, keys: string[], fallback: number): number {
  const n = numberFieldOrNull(fields, keys)
  return n !== null && n >= 0 ? n : fallback
}

/** Read a task priority (P1..P4) if present, else null. */
function priorityFieldOrNull(fields: Record<string, unknown>): 'P1' | 'P2' | 'P3' | 'P4' | null {
  const v = fields.priority
  if (v === 'P1' || v === 'P2' || v === 'P3' || v === 'P4') return v
  return null
}

/** Read a tracker input_type from fields, defaulting to 'number' (a sensible quantified default). */
function inputTypeField(fields: Record<string, unknown>): TrackerInputType {
  const v = fields.input_type
  const allowed: TrackerInputType[] = [
    'scale',
    'number',
    'single_select',
    'multi_select',
    'boolean',
    'text',
  ]
  if (typeof v === 'string' && (allowed as string[]).includes(v)) return v as TrackerInputType
  return 'number'
}

/** A minimal valid tracker `config` for the given input_type (satisfies core's schema). */
function defaultConfigFor(
  inputType: TrackerInputType,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  switch (inputType) {
    case 'scale': {
      // core requires min < max.
      const min = numberFieldOrNull(fields, ['min']) ?? 1
      const maxRaw = numberFieldOrNull(fields, ['max']) ?? 5
      const max = maxRaw > min ? maxRaw : min + 1
      return { input_type: 'scale', min: Math.trunc(min), max: Math.trunc(max) }
    }
    case 'number':
      return { input_type: 'number' }
    case 'single_select':
    case 'multi_select': {
      // core requires >= 1 non-empty option; supply a placeholder the user can edit.
      const opts = Array.isArray(fields.options)
        ? (fields.options as unknown[]).filter(
            (o): o is string => typeof o === 'string' && o.trim() !== '',
          )
        : []
      return { input_type: inputType, options: opts.length > 0 ? opts : ['option 1'] }
    }
    case 'boolean':
      return { input_type: 'boolean' }
    case 'text':
      return { input_type: 'text' }
    default: {
      const never: never = inputType
      throw new Error(`Unknown input_type: ${String(never)}`)
    }
  }
}

/** Coerce a tracker-entry value from the candidate fields to match the tracker's input_type. */
function coerceEntryValue(
  fields: Record<string, unknown>,
  inputType: TrackerInputType,
): number | string | boolean | string[] {
  const raw = fields.value
  switch (inputType) {
    case 'scale':
    case 'number': {
      const n = numberFieldOrNull(fields, ['value', 'quantity'])
      return n ?? (typeof raw === 'number' ? raw : 0)
    }
    case 'boolean':
      return typeof raw === 'boolean' ? raw : raw === 'true' || raw === 1
    case 'multi_select':
      return Array.isArray(raw)
        ? raw.filter((x): x is string => typeof x === 'string')
        : typeof raw === 'string'
          ? [raw]
          : []
    default:
      // single_select / text → a string value.
      return typeof raw === 'string' ? raw : raw === undefined ? '' : String(raw)
  }
}
