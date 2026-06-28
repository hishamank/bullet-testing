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
  SuggestionInsert,
  SuggestionOperation,
  SuggestionPayload,
  SuggestionTier,
  TargetKind,
  TrackerConfig,
  TrackerInputType,
} from '@bullet/core'
import type { AgentConfig } from '../config'
import type { Candidate } from '../extraction/schema'
import type { ExtractionSnapshot, SnapshotTask, SnapshotTracker } from '../extraction/snapshot'
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
 *
 * Returns the db `SuggestionInsert` (not a loose `Record<string, unknown>`), so the compiler —
 * not just this comment — guarantees the envelope/payload shape `createSuggestion` accepts. The
 * server-managed lifecycle fields (id/created_at/updated_at/state) are minted by the db on insert,
 * so they are intentionally omitted (the INSERT schema makes them optional); `status` is stated
 * explicitly as 'pending' — its schema default — so a fresh suggestion always persists as pending
 * (runtime-identical to relying on the default, now compiler-guaranteed).
 */
export function withProvenance(
  draft: ResolvedSuggestion,
  ownerId: string,
  sourceBulletId: string,
): SuggestionInsert {
  return {
    target_kind: draft.target_kind,
    operation: draft.operation,
    target_id: draft.target_id,
    confidence: draft.confidence,
    tier: draft.tier,
    owner_id: ownerId,
    source_bullet_id: sourceBulletId,
    status: 'pending',
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

  // A quantified reading + strong tracker match → append a tracker_entry — BUT only if the
  // value can be made valid for the tracker's config. If not (e.g. a single_select value outside
  // the option set), we do NOT emit a broken entry: we fall through to activity-first below so
  // the data is preserved as an UNLINKED activity create rather than lost.
  const trackerMatched =
    !!trackerHit && trackerScore >= MATCH_LINK_THRESHOLD && trackerScore >= taskScore
  if (trackerHit && trackerMatched) {
    const entry = appendTrackerEntry(candidate, trackerHit, config)
    if (entry) return entry
  }

  // A strong OPEN-TASK match → mark that task done (mutate an existing instance).
  if (taskHit && taskScore >= MATCH_LINK_THRESHOLD) {
    return markTaskDone(candidate, taskHit, config)
  }

  // Otherwise an action with no confident match → create an activity. Decide the tracker link
  // ONCE here and pass an already-resolved id to createActivity (no second threshold check):
  //  - present-but-weak match  → leave UNLINKED (activity-first; never guess a link we are not
  //    confident about).
  //  - matched STRONGLY but the append fell through (its value was invalid for that tracker's
  //    config, so `trackerMatched` is true yet we reached here) → ALSO leave unlinked: linking to
  //    a tracker that rejected the value would be misleading; we preserve the data, not the bad link.
  // So the link survives ONLY when the tracker hit cleared the threshold AND was not the
  // strong-but-value-invalid case — i.e. exactly when `trackerMatched` is false but the hit is strong.
  const linkedTrackerId =
    !trackerMatched && trackerHit && trackerScore >= MATCH_LINK_THRESHOLD
      ? trackerHit.item.id
      : null
  return createActivity(candidate, linkedTrackerId, config)
}

/**
 * happened + strong tracker → append a tracker_entry under the matched tracker.
 *
 * Returns `null` when the candidate value cannot be made valid for the tracker's config (e.g. a
 * `single_select` value not in the option set). The caller then falls back to an UNLINKED
 * activity create so the data is never lost (activity-first).
 */
function appendTrackerEntry(
  candidate: Candidate,
  trackerHit: Match<SnapshotTracker>,
  config: AgentConfig,
): ResolvedSuggestion | null {
  const value = coerceEntryValue(candidate.fields, trackerHit.item.input_type)
  // Validate/clamp against the tracker's config (@bullet/db defers this to us — see snapshot.ts).
  // `null` means "no valid value for this tracker" → caller falls back to activity-first.
  const validated = validateEntryValue(value, trackerHit.item.config)
  if (validated === null) return null

  const confidence = clamp01(combine(candidate.confidence, trackerHit.score))
  const payload: SuggestionPayload = {
    // `tracker_id` is part of the tracker_entry INSERT schema, so the apply engine's
    // re-validation (which runs BEFORE it wires tracker_id from target_id) requires it present.
    // The apply engine overrides it from target_id, so the two always agree.
    tracker_id: trackerHit.item.id,
    value: validated,
    logged_at: timestampField(candidate.fields, ['logged_at', 'occurred_at'], Date.now()),
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

/**
 * happened + no confident match → create an activity. The link decision is made ONCE by the
 * caller (`resolveHappened`); this function just records the already-resolved `linkedTrackerId`
 * (null = unlinked, activity-first).
 */
function createActivity(
  candidate: Candidate,
  linkedTrackerId: string | null,
  config: AgentConfig,
): ResolvedSuggestion {
  const name = stringField(candidate.fields, ['name', 'title'], candidate.text)
  const payload: SuggestionPayload = {
    name,
    occurred_at: timestampField(candidate.fields, ['occurred_at', 'logged_at'], Date.now()),
    tracker_id: linkedTrackerId,
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

/**
 * Validate/clamp a coerced entry value against the PARENT tracker's `config` (the agent is the
 * documented owner of this check — @bullet/db's apply engine defers it to us; see snapshot.ts).
 *
 * Returns the made-valid value, or `null` when the value cannot be salvaged for this tracker
 * (so the caller can fall back to an UNLINKED activity rather than emit a broken entry):
 *
 *  - `scale`         → clamp to [min, max].
 *  - `number`        → clamp to min/max when present (one-sided if only one is set).
 *  - `single_select` → value must be in `options`, else `null` (fall back to activity-first).
 *  - `multi_select`  → keep only options in the set (a valid subset); `[]` is a valid empty entry.
 *  - `boolean`/`text`→ unchanged.
 */
function validateEntryValue(
  value: number | string | boolean | string[],
  config: TrackerConfig,
): number | string | boolean | string[] | null {
  switch (config.input_type) {
    case 'scale': {
      if (typeof value !== 'number') return null
      return Math.max(config.min, Math.min(config.max, value))
    }
    case 'number': {
      if (typeof value !== 'number') return null
      let n = value
      if (config.min !== undefined) n = Math.max(config.min, n)
      if (config.max !== undefined) n = Math.min(config.max, n)
      return n
    }
    case 'single_select': {
      // A single_select with a value outside the option set cannot be made valid → fall back.
      return typeof value === 'string' && config.options.includes(value) ? value : null
    }
    case 'multi_select': {
      // Keep only the values present in the option set (a valid, possibly-empty, subset).
      const arr = Array.isArray(value) ? value : []
      return arr.filter((v) => config.options.includes(v))
    }
    default:
      // boolean / text — no config-driven bounds to enforce.
      return value
  }
}
