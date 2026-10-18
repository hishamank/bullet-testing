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

/** A suggestion draft plus the thought (by position) it was extracted from. */
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
}

/** Date questions first (they change what gets scheduled), then the rest, in capture order. */
const QUESTION_PRIORITY: Record<QuestionDraft['topic'], number> = {
  date: 0,
  new_tracker: 1,
  other: 2,
}

export async function processCapture(
  deps: { llm: LlmClient; config: EngineConfig },
  input: CaptureContext & { text: string },
  snapshot: ExtractionSnapshot,
  opts: { chunkChars?: number } = {},
): Promise<CaptureOutcome> {
  const ctx: CaptureContext = { capturedAt: input.capturedAt, timezone: input.timezone }
  const thoughts = await segmentCapture(deps, input, opts)
  const things: ThingDraft[] = []
  const questions: CaptureQuestionDraft[] = []
  let skipped = 0

  for (const thought of thoughts) {
    if (!EXTRACTABLE_THOUGHT_KINDS.includes(thought.kind)) continue
    const candidates = await extractCandidates(deps, { text: thought.text, ...ctx }, snapshot)
    const outcome = resolveCandidates(candidates, snapshot, deps.config, ctx)
    const base = things.length
    things.push(...outcome.suggestions.map((s) => ({ ...s, thoughtPosition: thought.position })))
    for (const q of outcome.questions) {
      const { suggestionIndex, ...rest } = q
      questions.push({
        ...rest,
        thoughtPosition: thought.position,
        thingIndex: suggestionIndex === null ? null : base + suggestionIndex,
      })
    }
    skipped += outcome.skipped
  }

  const capped = questions
    .map((q, i) => ({ q, i }))
    .sort((a, b) => QUESTION_PRIORITY[a.q.topic] - QUESTION_PRIORITY[b.q.topic] || a.i - b.i)
    .slice(0, MAX_QUESTIONS_PER_CAPTURE)
    .sort((a, b) => a.i - b.i)
    .map(({ q }) => q)

  return { thoughts, things, questions: capped, skipped }
}
