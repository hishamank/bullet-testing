/**
 * resolveCandidates — the create-vs-append brain (CLAUDE.md §4.4 + §4.5).
 *
 * Each LLM Candidate is routed to a `ResolvedSuggestion`: a Suggestion INSERT DRAFT
 * (`{ target_kind, operation, target_id, payload, confidence, tier }`). `owner_id` and
 * `source_bullet_id` are added at PERSIST time (queue/process.ts), so the resolver stays pure
 * and independent of the bullet/owner.
 *
 * Routing by orientation:
 *  - happened (a DETERMINISTIC three-way link decision on the matcher score — see the thresholds):
 *      • STRONG tracker match     → append a tracker_entry under that tracker (may auto).
 *      • STRONG open-task match   → update that task to status 'done' ("mutate an instance").
 *      • BORDERLINE tracker/task  → still LINK, but the tier is capped to 'suggest' (user confirms).
 *      • otherwise (sub-borderline, or a matched tracker that rejected the value) → create an
 *                                  UNLINKED activity ("activity-first", never drop the data).
 *  - future_oneoff   → create an EVENT when it is a happening with a resolvable date (the model
 *                      said `event`, or said `task` but it is an appointment-like thing at a clock
 *                      time); otherwise create a TASK (with `due_at` when a date was given).
 *  - future_recurring → create a tracker DEFINITION (recurring tasks/events: later slice → skipped).
 *  - durable_fact    → SKIPPED (Note is out of v1 scope) — counted, never persisted.
 *
 * Confidence: for append/update we COMBINE the model confidence with the fuse match score
 * (`combine`) so the final number is explainable; for plain creates we use the model
 * confidence directly.
 *
 * Time: every date is resolved against the bullet's CAPTURE context (time/when.ts) — the model's
 * quoted `when` phrase first, else the candidate's text. Records with no date default to the
 * capture time, never to processing time.
 */

import type {
  SuggestionInsert,
  ThoughtKind,
  SuggestionOperation,
  SuggestionPayload,
  SuggestionTier,
  TargetKind,
  TrackerConfig,
  TrackerInputType,
} from '@bullet/core'
import type { EngineConfig } from '../config'
import type { Candidate } from '../extraction/schema'
import type { ExtractionSnapshot, SnapshotTask, SnapshotTracker } from '../extraction/snapshot'
import type { QuestionTopic } from '@bullet/core'
import { ambiguousWeekday, type CaptureContext, resolveEnd, resolveWhen } from '../time/when'
import { safeTimezone, zonedParts, zonedToEpoch } from '../time/zoned'
import { type Match, matchOpenTask, matchTracker, TRACKER_NAME_FIELDS } from './match'
import { isKnownMeasure, trackerName, trackerNounFrom } from './naming'
import {
  convertDuration,
  normalizeUnit,
  type Reading,
  readingFromFields,
  readingFromText,
} from './reading'
import { assignTier } from './tier'
import { cleanTitle } from './title'

/** A Suggestion INSERT draft — owner_id/source_bullet_id are added when persisting. */
export interface ResolvedSuggestion {
  target_kind: TargetKind
  operation: SuggestionOperation
  target_id: string | null
  payload: SuggestionPayload
  confidence: number
  tier: SuggestionTier
  /**
   * A reading logged under a tracker that is itself only proposed: the index (in the same list)
   * of that tracker `create` suggestion. Persisting sets `payload.tracker_id` to its id (a
   * created entity's id is its suggestion's id), and accepting the tracker logs the reading.
   */
  dependsOn?: number
}

/** What the resolver knows about the thought the candidates came from. */
export interface ThoughtContext {
  kind?: ThoughtKind
  text?: string
}

/**
 * A clarifying question the resolver wants to ask about an ambiguous extraction (CLAUDE.md:
 * clarifying questions only in slice 1). `suggestionIndex` points into `suggestions`.
 */
export interface QuestionDraft {
  topic: QuestionTopic
  text: string
  options: string[]
  suggestionIndex: number | null
}

/**
 * The outcome of resolving a batch: the drafts to persist, clarifying questions, plus a count of
 * candidates SKIPPED (durable_fact / out-of-scope) so the data is never silently lost.
 */
export interface ResolveOutcome {
  suggestions: ResolvedSuggestion[]
  questions: QuestionDraft[]
  /** Count of candidates intentionally dropped (currently: durable_fact notes). */
  skipped: number
}

/** Collects questions about the suggestion currently being resolved. */
type Ask = (q: Omit<QuestionDraft, 'suggestionIndex'>) => void

const NUMBER: TrackerConfig = { input_type: 'number' }

/**
 * What one 'happened' candidate resolves to: usually one suggestion; a reading of something not
 * tracked yet is two (the tracker offer, then the reading that depends on it). `dependsOn` and
 * `questions[].at` index into `suggestions`.
 */
interface Happened {
  suggestions: ResolvedSuggestion[]
  questions: { at: number; q: Omit<QuestionDraft, 'suggestionIndex'> }[]
}

/** Thoughts about the future (a plan, an appointment): nothing in them has happened yet. */
const PLAN_THOUGHTS: readonly ThoughtKind[] = ['task', 'event']

/** Wanting to track something ("start tracking my mood", "suivre mon sommeil"). */
const TRACKING = /\b(track|tracking|suivre|log my|logging)\b/i

/** "Remind me to…", "don't forget to…": a one-off intention, never a tracker definition. */
const REMINDER =
  /\b(remind me|reminder|don'?t forget|do not forget|remember to|n'oublie|rappelle[- ]moi|fakkerne|fakirne|ma tensa)\b/i

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
  sourceThoughtId: string | null = null,
): SuggestionInsert {
  return {
    source_thought_id: sourceThoughtId,
    target_kind: draft.target_kind,
    operation: draft.operation,
    target_id: draft.target_id,
    confidence: draft.confidence,
    tier: draft.tier,
    owner_id: ownerId,
    source_bullet_id: sourceBulletId,
    status: 'pending',
    resolved_at: null,
    applied_entity_id: null,
    applied_at: null,
    auto_applied: false,
    // An UPDATE payload is a field-level patch of the target and must not carry provenance.
    payload:
      draft.operation === 'update'
        ? { ...draft.payload }
        : {
            ...draft.payload,
            owner_id: ownerId,
            source_bullet_id: sourceBulletId,
            source_thought_id: sourceThoughtId,
          },
  }
}

/**
 * Deterministic three-way link thresholds on the matcher's normalised score (1 = perfect). The
 * RESOLVER decides linking (CLAUDE.md §4.4: the LLM proposes, the resolver decides) — never the
 * model's `referenceName` alone:
 *
 *  - score ≥ STRONG_MATCH                    → LINK confidently (tracker_entry append / task
 *    mark-done) at the normal tier from {@link assignTier} (may auto-apply when confident).
 *  - BORDERLINE_MATCH ≤ score < STRONG_MATCH → LINK, but FORCE the tier down to at most 'suggest':
 *    a borderline link is plausible, not certain, so the USER confirms it — never auto (see
 *    {@link tierForLink}).
 *  - score < BORDERLINE_MATCH                → NO link → activity-first (UNLINKED); never lose data.
 *
 * Chosen against the matcher's real score distribution: exact + token/prefix containment matches
 * score ≥ 0.9 (STRONG); single-character typos land ≈ 0.67–0.8 (BORDERLINE); unrelated strings 0.
 */
const STRONG_MATCH = 0.85
const BORDERLINE_MATCH = 0.55

/** Combine model confidence with a match score into one explainable number (their mean). */
function combine(modelConfidence: number, matchScore: number): number {
  return (modelConfidence + matchScore) / 2
}

/** Lower a tier to at most 'suggest' (auto → suggest; suggest/ask unchanged) — the borderline cap. */
function capToSuggest(tier: SuggestionTier): SuggestionTier {
  return tier === 'auto' ? 'suggest' : tier
}

/**
 * The tier for a LINKED suggestion (tracker_entry append / task mark-done): the normal
 * {@link assignTier} result when the match is STRONG, but capped at 'suggest' when the match is
 * only BORDERLINE — the user confirms an uncertain link, we never auto-apply it. Implemented as an
 * explicit min(assignTier, 'suggest') for the borderline band.
 *
 * `valueBearing` is threaded into {@link assignTier} so the value-record cap composes with the
 * borderline cap: a STRONG-linked tracker_entry is still capped to 'suggest' by the value rule
 * (unless `config.autoApplyValueRecords`), while a borderline link is capped regardless. Either cap
 * alone forces 'suggest'.
 */
function tierForLink(
  kind: TargetKind,
  operation: SuggestionOperation,
  confidence: number,
  matchScore: number,
  config: EngineConfig,
  valueBearing: boolean,
): SuggestionTier {
  const tier = assignTier(kind, operation, confidence, config, { valueBearing })
  return matchScore >= STRONG_MATCH ? tier : capToSuggest(tier)
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
  config: EngineConfig,
  ctx: CaptureContext,
  thought: ThoughtContext = {},
): ResolveOutcome {
  const suggestions: ResolvedSuggestion[] = []
  const questions: QuestionDraft[] = []
  let skipped = 0
  // A question raised while resolving a candidate is about the suggestion it pushes next.
  const ask: Ask = (q) => questions.push({ ...q, suggestionIndex: suggestions.length })

  for (const candidate of candidates) {
    // Small local models (e.g. gemma3:4b) sometimes WRAP field values one level deep under
    // structured output — `value: { value: 3 }`, `name: { name: 'mood' }`. Flatten that single
    // level ONCE here so every downstream reader works on primitives unchanged (see flattenFields).
    const normalized = rerouted(
      { ...candidate, fields: flattenFields(candidate.fields) },
      thought,
      ctx,
    )
    switch (normalized.orientation) {
      case 'happened': {
        const resolved = resolveHappened(normalized, snapshot, config, ctx, thought)
        // A plan ("Pay the electricity bill") has not happened: a record extracted from it ("Paid
        // the electricity bill") is the model's invention. Marking an open task done stays.
        const closesTask = resolved.suggestions.some(
          (s) => s.target_kind === 'task' && s.operation === 'update',
        )
        if (thought.kind !== undefined && PLAN_THOUGHTS.includes(thought.kind) && !closesTask) {
          skipped += 1
          break
        }
        const base = suggestions.length
        for (const s of resolved.suggestions) {
          suggestions.push(s.dependsOn === undefined ? s : { ...s, dependsOn: base + s.dependsOn })
        }
        for (const { at, q } of resolved.questions) {
          questions.push({ ...q, suggestionIndex: base + at })
        }
        break
      }
      case 'future_oneoff': {
        suggestions.push(resolveFutureOneoff(normalized, config, ctx, ask))
        break
      }
      case 'future_recurring': {
        // Only trackers are recurring DEFINITIONS in slice 1; recurring tasks/events come with
        // recurrence later. Count them (the bullet itself keeps the text) rather than mint a
        // one-off that misrepresents them.
        if (normalized.kind === 'task' || normalized.kind === 'event') {
          skipped += 1
          break
        }
        suggestions.push(resolveFutureRecurring(normalized, config))
        break
      }
      case 'durable_fact': {
        // Note is out of v1 scope — emit NOTHING but count it (never lose track).
        skipped += 1
        break
      }
      default: {
        // Exhaustiveness guard; orientation is a closed union.
        const never: never = normalized.orientation
        throw new Error(`Unknown orientation: ${String(never)}`)
      }
    }
  }

  return { suggestions, questions, skipped }
}

/**
 * Deterministic backstops on the model's routing:
 *  - a "tracker definition" for a one-off intention ("Remind me to buy olive oil tomorrow"): a
 *    reminder, a dated one-off, or a thought the segmenter called a task/event is a TASK;
 *  - an `activity` the model labelled a plan in a plan thought keeps its plan orientation.
 */
function rerouted(candidate: Candidate, thought: ThoughtContext, ctx: CaptureContext): Candidate {
  if (candidate.orientation === 'future_recurring' && candidate.kind === 'tracker') {
    const said = `${candidate.text} ${thought.text ?? ''}`
    // "Start tracking my mood from tomorrow" really is a tracker.
    if (TRACKING.test(said) && !REMINDER.test(said)) return candidate
    // A plan thought ("Buy olive oil tomorrow") whose date is its "when", or a reminder.
    const when = stringFieldOrNull(candidate.fields, ['when', 'date', 'due']) ?? candidate.text
    const plan =
      thought.kind !== undefined &&
      PLAN_THOUGHTS.includes(thought.kind) &&
      resolveWhen(when, ctx, 'future') !== null
    const oneOff = REMINDER.test(said) || plan
    if (oneOff) {
      const title = stringFieldOrNull(candidate.fields, ['title', 'name']) ?? candidate.text
      return {
        ...candidate,
        kind: 'task',
        orientation: 'future_oneoff',
        fields: { ...candidate.fields, title },
      }
    }
  }
  return candidate
}

/**
 * The reading a 'happened' candidate carries, if any: the model's value (under `value`,
 * `quantity`, `duration`…), else a number/duration/scale recovered from its words. A lone number
 * counts only when the thing is known to be a reading (a tracker thought or tracker candidate).
 */
function readingOf(candidate: Candidate, thought: ThoughtContext): Reading | null {
  const readingKind =
    candidate.kind === 'tracker_entry' || candidate.kind === 'tracker' || thought.kind === 'tracker'
  const fromFields = readingFromFields(candidate.fields)
  if (fromFields) {
    // The model's number with the text's unit/scale, when it left those out.
    if (fromFields.unit === null && fromFields.scale === null) {
      const fromText = readingFromText(candidate.text, { allowBare: false })
      if (fromText && fromText.value === fromFields.value) return fromText
    }
    return fromFields
  }
  return (
    readingFromText(candidate.text, { allowBare: readingKind }) ??
    (readingKind && thought.text ? readingFromText(thought.text, { allowBare: true }) : null)
  )
}

/** Route a 'happened' candidate: append a tracker entry, mark a task done, or create activity. */
function resolveHappened(
  candidate: Candidate,
  snapshot: ExtractionSnapshot,
  config: EngineConfig,
  ctx: CaptureContext,
  thought: ThoughtContext,
): Happened {
  const occurredAt = recordTime(candidate, ctx)
  const reading = readingOf(candidate, thought)
  const readingKind =
    candidate.kind === 'tracker_entry' || candidate.kind === 'tracker' || thought.kind === 'tracker'
  // The user's own words: a link or a name the model gives must be borne out by them. Live, a
  // small model "referenced" the only existing tracker for every reading ("Slept 6 hours" →
  // Meditation, logged as 360 min).
  const words = { ...candidate, referenceName: undefined, fields: {} }
  const wordsNoun = trackerNounFrom(`${candidate.text}`)
  const borneOut = (n: string | null | undefined): n is string =>
    typeof n === 'string' &&
    n.trim() !== '' &&
    (wordsNoun === null ||
      matchTracker(
        words,
        [{ id: '', name: n, input_type: 'number', config: NUMBER }],
        [wordsNoun],
      ) !== undefined)
  const modelNames = [
    stringFieldOrNull(candidate.fields, [...TRACKER_NAME_FIELDS]),
    readingKind ? (candidate.referenceName ?? null) : null,
    stringFieldOrNull(candidate.fields, ['name', 'title']),
  ]
  // What is measured, as a short noun ("Sleep"): the tracker's name, and one more way to match.
  const name = trackerName([...modelNames.filter(borneOut), candidate.text, ...modelNames])
  // A number logged under the wrong measurement is the harm, so a number/scale tracker the words
  // don't name is not a candidate at all (the best match among the others still wins); a
  // select/yes-no value is checked against the tracker's options instead.
  const measured = (t: SnapshotTracker) => t.input_type === 'number' || t.input_type === 'scale'
  const eligible = snapshot.trackers.filter((t) => !measured(t) || borneOut(t.name))
  const trackerHit = matchTracker(candidate, eligible, reading ? [name] : [])
  const taskHit = matchOpenTask(candidate, snapshot.openTasks)
  const one = (s: ResolvedSuggestion): Happened => ({ suggestions: [s], questions: [] })

  // Prefer whichever existing thing matches more strongly (and clears the BORDERLINE gate).
  const trackerScore = trackerHit?.score ?? 0
  const taskScore = taskHit?.score ?? 0

  // A quantified reading + a tracker match that clears BORDERLINE and is at least as strong as any
  // open-task match → append a tracker_entry — BUT only if the value can be made valid for the
  // tracker's config. If not (e.g. a single_select value outside the option set), we do NOT emit a
  // broken entry: we fall through to activity-first below so the data is preserved as an UNLINKED
  // activity create rather than lost. Borderline matches are honoured as links here but have their
  // tier capped to 'suggest' inside {@link appendTrackerEntry} (the user confirms the link).
  if (trackerHit && trackerScore >= BORDERLINE_MATCH && trackerScore >= taskScore) {
    const entry = appendTrackerEntry(candidate, trackerHit, config, occurredAt, reading)
    if (entry) return one(entry)
  }

  // An OPEN-TASK match that clears BORDERLINE → mark that task done (mutate an existing instance);
  // its tier is likewise capped to 'suggest' when the match is only borderline. A reading only
  // closes a task it matches strongly ("ran 5k" ↔ "Run 5k"); otherwise it is logged.
  if (taskHit && taskScore >= (reading ? STRONG_MATCH : BORDERLINE_MATCH)) {
    return one(markTaskDone(candidate, taskHit, config))
  }

  // A reading of something not tracked yet (decision 3): never a value-less activity. Offer the
  // tracker ("Start tracking Sleep?", a definition: never auto) and the reading as a tracker
  // entry that depends on it, waiting for a tap. A tracker that matched but rejected the value
  // keeps the value on an activity instead (value-bearing, so never auto either).
  // A NEW tracker is only offered for a reading (a tracker thought or candidate) or a thing people
  // track ("Sleep", "Water"); "spent 2 hours at the dentist" keeps its value on an activity.
  if (
    reading &&
    !(trackerHit && trackerScore >= BORDERLINE_MATCH) &&
    (readingKind || isKnownMeasure(name))
  ) {
    return newTrackerWithReading(candidate, config, ctx, occurredAt, reading, name)
  }

  // No match that clears BORDERLINE (or a tracker matched but its value was invalid for that
  // tracker and we fell through) → create an UNLINKED activity (activity-first). We deliberately do
  // NOT link the activity to a sub-borderline or value-rejected tracker: we preserve the data, not
  // a guessed link. A confident-enough tracker link is already handled above as a tracker_entry.
  //
  // INTENDED value-rule interaction for a STRONG-but-categorical-invalid match (e.g. a single_select
  // value not in the option set): appendTrackerEntry returned null, so the invalid categorical value
  // is DROPPED (never written). The data degrades to a value-LESS unlinked activity (its `value`
  // wasn't a quantity, so `quantity` reads null) that is therefore auto-eligible again. This is
  // consistent with the value rule: no WRONG value is ever silently written — only a value-less
  // record can auto-apply.
  return one(createActivity(candidate, config, ctx, occurredAt, reading))
}

/** The words of a reading without its value ("Slept 6 hours." → "Slept"); `fallback` if none. */
function readingActivityName(
  candidate: Candidate,
  ctx: CaptureContext,
  reading: Reading,
  fallback: string,
): string {
  const said = stringField(candidate.fields, ['name', 'title'], candidate.text)
  // A value the model gave (not read from the words) still has its words: find them to strip.
  const phrase = (reading.phrase ?? readingFromText(said, { allowBare: true })?.phrase)?.trim()
  const without = phrase
    ? said.replace(
        new RegExp(`${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s+(?:of|de|d'))?`, 'iu'),
        ' ',
      )
    : said
  const name = cleanTitle(without, ctx, { direction: 'past' })
  return /[\p{L}]/u.test(name) ? name : fallback
}

/**
 * "Not now" on a new tracker keeps its waiting reading as a plain activity with the value
 * ("Slept · 6 h", no tracker). The activity payload for a reading `entry` of tracker offer
 * `tracker` (both suggestion payloads); provenance is carried over.
 */
export function readingAsActivity(
  entry: SuggestionPayload,
  tracker: SuggestionPayload,
): SuggestionPayload {
  const config = (tracker.config ?? {}) as { unit?: unknown }
  const named = typeof entry.activity_name === 'string' && entry.activity_name.trim() !== ''
  return {
    name: named ? entry.activity_name : typeof tracker.name === 'string' ? tracker.name : 'Reading',
    occurred_at: entry.logged_at,
    tracker_id: null,
    notes: null,
    quantity: typeof entry.value === 'number' ? entry.value : null,
    unit: typeof config.unit === 'string' ? config.unit : null,
    owner_id: entry.owner_id,
    source_bullet_id: entry.source_bullet_id,
    source_thought_id: entry.source_thought_id ?? null,
  }
}

/** The question offered with a new tracker (decision 4: "Start tracking Mood?"). */
export function startTrackingQuestion(name: string): string {
  return `Start tracking ${name}?`
}

/**
 * A reading with no tracker to log it under: the tracker offer (a DEFINITION — never auto; "Yes"
 * or an accept is the user's confirmation) followed by the reading as a tracker entry that
 * depends on it (value-bearing: waits for a tap; logged when the tracker is accepted).
 */
function newTrackerWithReading(
  candidate: Candidate,
  config: EngineConfig,
  ctx: CaptureContext,
  loggedAt: number,
  reading: Reading,
  name: string,
): Happened {
  const confidence = clamp01(candidate.confidence)
  const min = Math.trunc(reading.scale?.min ?? 1)
  const max = Math.trunc(reading.scale?.max ?? 0)
  const trackerConfig =
    reading.scale && min < max && reading.value >= min && reading.value <= max
      ? { input_type: 'scale', min, max }
      : { input_type: 'number', ...(reading.unit ? { unit: reading.unit } : {}) }
  const tracker: ResolvedSuggestion = {
    target_kind: 'tracker',
    operation: 'create',
    target_id: null,
    payload: { name, input_type: trackerConfig.input_type, config: trackerConfig },
    confidence,
    tier: assignTier('tracker', 'create', confidence, config),
  }
  const entry: ResolvedSuggestion = {
    target_kind: 'tracker_entry',
    operation: 'create',
    target_id: null,
    // `activity_name`: what the reading is called if the tracker is declined ("Not now" keeps it
    // as an activity: "Slept · 6 h"). Ignored when it is logged as an entry.
    payload: {
      value: reading.value,
      logged_at: loggedAt,
      activity_name: readingActivityName(candidate, ctx, reading, name),
    },
    confidence,
    // Its tracker does not exist yet: it can never apply on its own, whatever the config says.
    tier: capToSuggest(
      assignTier('tracker_entry', 'create', confidence, config, { valueBearing: true }),
    ),
    dependsOn: 0,
  }
  return {
    suggestions: [tracker, entry],
    questions: [
      {
        at: 0,
        q: { topic: 'new_tracker', text: startTrackingQuestion(name), options: ['Yes', 'No'] },
      },
    ],
  }
}

/**
 * When a 'happened' record happened: the quoted `when` phrase, else a date/time phrase in the
 * candidate's text, else the CAPTURE time. A record cannot be in the future, so a resolution
 * past the capture time is clamped to it. A day with no time of day is not its midnight: "today"
 * ("mood 3 today", "slept 6 hours" read as today) is the capture time, an earlier day its noon.
 */
function recordTime(candidate: Candidate, ctx: CaptureContext): number {
  const when = whenFor(candidate, ctx, 'past')
  if (!when) return ctx.capturedAt
  if (!when.hasTime) {
    const timezone = safeTimezone(ctx.timezone)
    if (sameLocalDay(when.at, ctx.capturedAt, timezone)) return ctx.capturedAt
    const day = zonedParts(when.at, timezone)
    return Math.min(zonedToEpoch({ ...day, hour: 12, minute: 0 }, timezone), ctx.capturedAt)
  }
  return Math.min(when.at, ctx.capturedAt)
}

/**
 * Resolve the candidate's date phrase: the model's quoted `when` first, then its text slice. A
 * quote that kept only the day ("Demain" of "Demain réunion à 15h") takes the time of day from
 * the text when the text names the same day.
 */
function whenFor(candidate: Candidate, ctx: CaptureContext, direction: 'future' | 'past') {
  const quoted = stringFieldOrNull(candidate.fields, ['when', 'date', 'due', 'starts'])
  const fromQuote = quoted ? resolveWhen(quoted, ctx, direction) : null
  const fromText = resolveWhen(candidate.text, ctx, direction)
  if (fromQuote && !fromQuote.hasTime && fromText?.hasTime) {
    const timezone = safeTimezone(ctx.timezone)
    if (sameLocalDay(fromQuote.at, fromText.at, timezone)) return fromText
  }
  return fromQuote ?? fromText
}

function sameLocalDay(a: number, b: number, timezone: string): boolean {
  const x = zonedParts(a, timezone)
  const y = zonedParts(b, timezone)
  return x.year === y.year && x.month === y.month && x.day === y.day
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
  config: EngineConfig,
  loggedAt: number,
  reading: Reading | null,
): ResolvedSuggestion | null {
  const fromReading = readingValueFor(reading, trackerHit.item.config)
  // A reading on another scale or unit ("mood 7/10" for a 1–5 tracker, "5 miles" for km) is not
  // clamped or converted silently: the caller keeps it on an activity, for the user to look at.
  if (fromReading === MISMATCH) return null
  const value = fromReading ?? coerceEntryValue(candidate.fields, trackerHit.item.input_type)
  // No usable value (e.g. "checked my weight" against a number tracker) → never invent one.
  if (value === null) return null
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
    logged_at: loggedAt,
  }
  return {
    target_kind: 'tracker_entry',
    operation: 'append',
    target_id: trackerHit.item.id,
    payload,
    confidence,
    // A tracker_entry IS a logged value → value-bearing: capped at 'suggest' by default (never a
    // silent auto value) unless `config.autoApplyValueRecords`. On top of that, a borderline match
    // caps the tier at 'suggest' too. Both caps compose inside {@link tierForLink}.
    tier: tierForLink('tracker_entry', 'append', confidence, trackerHit.score, config, true),
  }
}

/** happened + strong open task → update that task to status 'done'. */
function markTaskDone(
  candidate: Candidate,
  taskHit: Match<SnapshotTask>,
  config: EngineConfig,
): ResolvedSuggestion {
  const confidence = clamp01(combine(candidate.confidence, taskHit.score))
  // A field-level PATCH: only what changes. The apply engine validates it against the task UPDATE
  // schema and writes just these keys, so it can never revert edits the user made after the
  // snapshot was taken (the legacy full-snapshot payload did).
  const payload: SuggestionPayload = { status: 'done' }
  const tier = tierForLink('task', 'update', confidence, taskHit.score, config, false)
  return {
    target_kind: 'task',
    operation: 'update',
    target_id: taskHit.item.id,
    payload,
    confidence,
    // A mark-done carries no value, so it may auto — but only on an EXACT title match. A
    // containment match ("called mom" vs "call mom about the trip") is plausible, not certain:
    // closing the wrong task silently is worse than one tap, so it is capped at 'suggest'.
    tier: taskHit.score >= 1 ? tier : capToSuggest(tier),
  }
}

/**
 * happened + no confident-enough match → create an UNLINKED activity (activity-first). In the
 * three-way link model (see {@link resolveHappened}) a confident tracker match is already routed to
 * a tracker_entry append, so an activity here is always unlinked: we preserve the data, never guess
 * a link. `tracker_id` is therefore `null` (the domain permits linked activities; the resolver just
 * never mints one from an uncertain match).
 */
function createActivity(
  candidate: Candidate,
  config: EngineConfig,
  ctx: CaptureContext,
  occurredAt: number,
  reading: Reading | null,
): ResolvedSuggestion {
  // Like a title: the user's words, without the date (it is `occurred_at`) or end punctuation.
  const name = cleanTitle(stringField(candidate.fields, ['name', 'title'], candidate.text), ctx, {
    direction: 'past',
    fallback: candidate.text,
  })
  // A quantity makes the activity VALUE-BEARING (e.g. "drank 3 coffees") → the tier is capped to
  // 'suggest' by default (a value is never auto-applied silently). A quantity-less activity ("went
  // for a walk") is value-less and stays auto-eligible.
  const quantity = reading?.value ?? numberFieldOrNull(candidate.fields, ['quantity', 'value'])
  const payload: SuggestionPayload = {
    name,
    occurred_at: occurredAt,
    tracker_id: null,
    notes: stringFieldOrNull(candidate.fields, ['notes']),
    quantity,
    unit: reading?.unit ?? stringFieldOrNull(candidate.fields, ['unit']),
  }
  const confidence = clamp01(candidate.confidence)
  return {
    target_kind: 'activity',
    operation: 'create',
    target_id: null,
    payload,
    confidence,
    tier: assignTier('activity', 'create', confidence, config, { valueBearing: quantity != null }),
  }
}

/**
 * Appointment-like nouns: a future one-off naming one of these AT A CLOCK TIME is a happening (an
 * Event) even when the model labelled it a task. Deterministic backstop for small models.
 */
const EVENT_NOUNS =
  /\b(appointment|appt|meeting|interview|dinner|lunch|breakfast|brunch|party|wedding|concert|flight|train|game|match|class|lesson|session|show|movie|date|checkup|check-up|dentist|doctor)\b/i

/**
 * A deadline ("before 10am", "by Friday", "avant demain", "2abel l 5amis") marks something to DO
 * by a time — a Task due then, even when the model labelled it an event. Small models do.
 */
const DEADLINE =
  /(?<![\p{L}\p{N}])(?:before|by|no later than|avant|abel|2abel|abl|2abl|qabl)\s+(?=\d|today|tonight|tomorrow|noon|midnight|the end|end|next|this|mon|tue|wed|thu|fri|sat|sun|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|demain|ce soir|midi|bu?o?kra|e?l\s)/iu

/** future_oneoff → an Event (a happening with a date) or a Task. */
function resolveFutureOneoff(
  candidate: Candidate,
  config: EngineConfig,
  ctx: CaptureContext,
  ask: Ask,
): ResolvedSuggestion {
  const when = whenFor(candidate, ctx, 'future')
  // Decision 5: a short phrase in the user's words; the date and time live in the fields.
  const title = cleanTitle(stringField(candidate.fields, ['title', 'name'], candidate.text), ctx, {
    direction: 'future',
    fallback: candidate.text,
  })
  const quoted = stringFieldOrNull(candidate.fields, ['when', 'date', 'due', 'starts'])
  if (quoted && !when) {
    // The user said when, but we could not read it: ask rather than guess.
    ask({ topic: 'date', text: `When is "${title}"? ("${quoted}")`, options: [] })
  } else if (when) {
    const day = ambiguousWeekday(quoted ?? candidate.text, ctx)
    if (day) {
      ask({
        topic: 'date',
        text: `Which ${day} for "${title}"?`,
        options: ['Today', `Next ${day}`],
      })
    }
  }
  const said = `${title} ${candidate.text}`
  const isDeadline = DEADLINE.test(`${quoted ?? ''} ${candidate.text}`) && !EVENT_NOUNS.test(said)
  const isHappening =
    (candidate.kind === 'event' && !isDeadline) ||
    (candidate.kind === 'task' && when?.hasTime === true && EVENT_NOUNS.test(said))
  // An event needs a date; one without falls back to a task (nothing is lost, the user can date it).
  if (isHappening && when) return createEvent(candidate, config, ctx, title, when)

  const payload: SuggestionPayload = {
    title,
    // Date-only due dates are stored at local midnight starting that day.
    due_at: when?.at ?? null,
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

/** A future happening with a resolved start → create an Event. */
function createEvent(
  candidate: Candidate,
  config: EngineConfig,
  ctx: CaptureContext,
  title: string,
  when: { at: number; hasTime: boolean },
): ResolvedSuggestion {
  const endPhrase = stringFieldOrNull(candidate.fields, ['end_when', 'end', 'until'])
  const payload: SuggestionPayload = {
    title,
    starts_at: when.at,
    ends_at: endPhrase ? resolveEnd(endPhrase, when.at, ctx.timezone) : null,
    all_day: !when.hasTime,
    location: stringFieldOrNull(candidate.fields, ['location', 'place', 'where']),
    notes: stringFieldOrNull(candidate.fields, ['notes']),
  }
  const confidence = clamp01(candidate.confidence)
  return {
    target_kind: 'event',
    operation: 'create',
    target_id: null,
    payload,
    confidence,
    tier: assignTier('event', 'create', confidence, config),
  }
}

/** future_recurring → create a tracker DEFINITION (never auto). */
function resolveFutureRecurring(candidate: Candidate, config: EngineConfig): ResolvedSuggestion {
  // A short noun for the measured thing ("track my mood every day" → "Mood"), never the sentence.
  const name = trackerName([
    stringFieldOrNull(candidate.fields, [...TRACKER_NAME_FIELDS, 'name', 'title']),
    candidate.referenceName,
    candidate.text,
  ])
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

/** The canonical inner keys a model uses when it wraps a field value in a single-key object. */
const WRAPPER_INNER_KEYS = ['value', 'name', 'title', 'text'] as const

/**
 * Unwrap ONE level of the small-model "value wrapping" quirk on a single field value.
 *
 * Some local models (e.g. gemma3:4b) wrap field VALUES in an object even under structured output —
 * `{ value: 3 }` instead of `3`, `{ name: 'mood' }` instead of `'mood'`. Downstream readers expect
 * primitives, so a wrapped number silently corrupts (numberFieldOrNull sees an object → null →
 * coerced to 0 → a scale tracker clamps to its min: a mood of 3 logs as 1). We undo exactly ONE
 * level of that wrapping here:
 *
 *  - `null` / primitive / Array        → returned UNCHANGED (arrays are legitimate, e.g. the value
 *                                        of a multi_select entry is a string[]).
 *  - plain object with exactly ONE key → that key's value. This is intentionally broader than the
 *    observed `value`/`name`/… wrapper keys: a single-key object is ALWAYS the model wrapping a
 *    scalar (v1 field values are only ever primitives/arrays — no reader consumes object-valued
 *    fields), so unwrapping any single-key wrapper is safe and robust to unseen wrapper keys.
 *  - plain object containing one of {@link WRAPPER_INNER_KEYS} → the first such key's value.
 *  - any other object (incl. empty `{}`) → returned UNCHANGED (the readers ignore non-primitives
 *                                        and fall back to the text slice, exactly as today).
 *
 * One level ONLY — the observed nesting is one level deep; we never recurse arbitrarily.
 */
export function unwrapValue(v: unknown): unknown {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return v
  const obj = v as Record<string, unknown>
  const keys = Object.keys(obj)
  const [only] = keys
  if (keys.length === 1 && only !== undefined) return obj[only]
  for (const k of WRAPPER_INNER_KEYS) {
    if (Object.hasOwn(obj, k)) return obj[k]
  }
  return v
}

/**
 * Normalise a candidate's loose `fields` by passing each top-level value through
 * {@link unwrapValue}. Keys are unchanged; already-flat fields pass through untouched. Applied
 * ONCE per candidate at the top of {@link resolveCandidates} so all downstream readers see
 * primitives.
 */
export function flattenFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) {
    out[k] = unwrapValue(v)
  }
  return out
}

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

/**
 * A reading's value as the tracker wants it: a number for a number/scale tracker, converted
 * between hours and minutes when the units differ. Null when it does not apply (the caller then
 * reads the model's fields as before).
 */
const MISMATCH = 'mismatch' as const

function readingValueFor(
  reading: Reading | null,
  config: TrackerConfig,
): number | null | typeof MISMATCH {
  if (!reading) return null
  if (config.input_type === 'scale') {
    if (reading.scale && reading.scale.max !== config.max) return MISMATCH
    if (reading.value < config.min || reading.value > config.max) return MISMATCH
    return reading.value
  }
  if (config.input_type !== 'number') return null
  const want = normalizeUnit(config.unit)
  let value = reading.value
  if (want !== null && reading.unit !== null && want !== reading.unit) {
    const converted = convertDuration(reading.value, reading.unit, want)
    if (converted === null) return MISMATCH
    value = converted
  }
  if (config.min !== undefined && value < config.min) return MISMATCH
  if (config.max !== undefined && value > config.max) return MISMATCH
  return value
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

/**
 * Coerce a tracker-entry value from the candidate fields to match the tracker's input_type.
 * Returns null when there is no usable value: a scale/number reading with no number must NOT
 * default to 0 (which the scale clamp then turned into the minimum — "mood" logged as 1).
 */
function coerceEntryValue(
  fields: Record<string, unknown>,
  inputType: TrackerInputType,
): number | string | boolean | string[] | null {
  const raw = fields.value
  switch (inputType) {
    case 'scale':
    case 'number': {
      const n = numberFieldOrNull(fields, ['value', 'quantity'])
      if (n !== null) return n
      // A numeric string ("4", "72.5") is fine; anything else is not a reading.
      const parsed = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN
      return Number.isFinite(parsed) ? parsed : null
    }
    case 'boolean':
      // Mentioning a yes/no tracker as something that happened ("took my meds") means yes.
      if (raw === undefined || raw === null) return true
      return typeof raw === 'boolean' ? raw : raw === 'true' || raw === 1 || raw === 'yes'
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
