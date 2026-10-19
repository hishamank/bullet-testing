/**
 * processCapture — the whole slice-1 pipeline for one capture, as pure orchestration over the
 * injected LLM: capture text → thoughts (segmentation, chunked for long captures) → things
 * (extraction + resolution per actionable thought) → clarifying questions (capped per capture).
 * The server persists the result; nothing here touches storage or the clock.
 */

import { MAX_QUESTIONS_PER_CAPTURE, type ThoughtKind } from '@bullet/core'
import type { EngineConfig } from './config'
import { extractCandidates } from './extraction/extract'
import type { ExtractionSnapshot } from './extraction/snapshot'
import type { LlmClient } from './llm/types'
import { dedupeOutcome } from './resolution/dedupe'
import {
  type QuestionDraft,
  type ResolvedSuggestion,
  resolveCandidates,
} from './resolution/resolve'
import { segmentCapture, type SegmentedThought } from './segmentation/segment'
import type { CaptureContext } from './time/when'

/**
 * Thought kinds things are extracted from. Worries, ideas, notes and self-questions are KEPT as
 * thoughts but not mined for things in slice 1 (reflection on them is slice 2) — this also keeps
 * a long ramble to one model call per actionable thought.
 */
export const EXTRACTABLE_THOUGHT_KINDS: readonly ThoughtKind[] = [
  'task',
  'event',
  'tracker',
  'activity',
  'to_check',
]

/**
 * A suggestion draft plus the thought (by position) it was extracted from. `dependsOn` indexes
 * into the capture's `things` (a reading's proposed tracker).
 */
export interface ThingDraft extends ResolvedSuggestion {
  thoughtPosition: number
}

/** A question draft about a thought and (optionally) one of the capture's thing drafts. */
export interface CaptureQuestionDraft extends Omit<QuestionDraft, 'suggestionIndex'> {
  thoughtPosition: number
  /** Index into `things`. */
  thingIndex: number | null
}

export interface CaptureOutcome {
  thoughts: SegmentedThought[]
  things: ThingDraft[]
  questions: CaptureQuestionDraft[]
  /** Candidates intentionally not turned into things (counted, never silently lost). */
  skipped: number
  /** Repeated candidates within one thought, dropped in favour of the first (see dedupe.ts). */
  duplicates: number
}

/** Date questions first (they change what gets scheduled), then the rest, in capture order. */
const QUESTION_PRIORITY: Record<QuestionDraft['topic'], number> = {
  date: 0,
  new_tracker: 1,
  other: 2,
}

/** A thought this capture had before (it is being processed again), with its kind. */
export interface PriorThought {
  text: string
  kind: ThoughtKind
}

const normThought = (s: string) => s.normalize('NFC').toLowerCase().trim().replace(/\s+/g, ' ')

/**
 * Re-processing (an edit, a retry) asks the model again, and a small model's kind wobbles
 * (`to_check` one run, `task` the next). A thought whose text is unchanged keeps its previous
 * kind — the user's re-classification included — so extraction runs on the same reading.
 */
export function keepPriorKinds(
  thoughts: SegmentedThought[],
  prior: readonly PriorThought[],
): SegmentedThought[] {
  if (prior.length === 0) return thoughts
  const byText = new Map(prior.map((p) => [normThought(p.text), p.kind]))
  return thoughts.map((t) => {
    const kind = byText.get(normThought(t.text))
    return kind && kind !== t.kind ? { ...t, kind } : t
  })
}

const trackerKey = (s: ResolvedSuggestion): string | null =>
  s.target_kind === 'tracker' && s.operation === 'create' && typeof s.payload.name === 'string'
    ? normThought(s.payload.name)
    : null

export async function processCapture(
  deps: { llm: LlmClient; config: EngineConfig },
  input: CaptureContext & { text: string; priorThoughts?: readonly PriorThought[] },
  snapshot: ExtractionSnapshot,
  opts: { chunkChars?: number } = {},
): Promise<CaptureOutcome> {
  const ctx: CaptureContext = { capturedAt: input.capturedAt, timezone: input.timezone }
  const thoughts = keepPriorKinds(
    await segmentCapture(deps, input, opts),
    input.priorThoughts ?? [],
  )
  const things: ThingDraft[] = []
  const questions: CaptureQuestionDraft[] = []
  // New trackers offered so far in this capture, by name: "mood 3 … mood 4 later" offers one.
  const offeredTrackers = new Map<string, number>()
  let skipped = 0
  let duplicates = 0

  for (const thought of thoughts) {
    if (!EXTRACTABLE_THOUGHT_KINDS.includes(thought.kind)) continue
    const candidates = await extractCandidates(deps, { text: thought.text, ...ctx }, snapshot)
    // The model sometimes repeats a candidate; one thought never yields the same thing twice.
    const outcome = dedupeOutcome(
      resolveCandidates(candidates, snapshot, deps.config, ctx, {
        kind: thought.kind,
        text: thought.text,
      }),
    )
    // Local index → index in `things` (or the earlier offer of the same tracker it merges into).
    const at: (number | null)[] = []
    for (const s of outcome.suggestions) {
      const key = trackerKey(s)
      const earlier = key === null ? undefined : offeredTrackers.get(key)
      if (earlier !== undefined) {
        at.push(earlier)
        duplicates += 1
        continue
      }
      const dependsOn = s.dependsOn === undefined ? undefined : (at[s.dependsOn] ?? undefined)
      if (key !== null) offeredTrackers.set(key, things.length)
      at.push(things.length)
      things.push({
        ...s,
        ...(dependsOn === undefined ? {} : { dependsOn }),
        thoughtPosition: thought.position,
      })
    }
    for (const q of outcome.questions) {
      const { suggestionIndex, ...rest } = q
      const thingIndex = suggestionIndex === null ? null : (at[suggestionIndex] ?? null)
      // The merged offer already has its "Start tracking …?" question.
      if (
        thingIndex !== null &&
        questions.some((x) => x.thingIndex === thingIndex && x.text === rest.text)
      ) {
        continue
      }
      questions.push({ ...rest, thoughtPosition: thought.position, thingIndex })
    }
    skipped += outcome.skipped
    duplicates += outcome.duplicates
  }

  const capped = questions
    .map((q, i) => ({ q, i }))
    .sort((a, b) => QUESTION_PRIORITY[a.q.topic] - QUESTION_PRIORITY[b.q.topic] || a.i - b.i)
    .slice(0, MAX_QUESTIONS_PER_CAPTURE)
    .sort((a, b) => a.i - b.i)
    .map(({ q }) => q)

  return { thoughts, things, questions: capped, skipped, duplicates }
}
