/**
 * dedupeOutcome — drop duplicate things the extraction model returned for ONE thought.
 *
 * Small local models sometimes repeat a candidate (two identical "take the car to the garage"
 * tasks, three identical "réunion avec Karim à 15h" events). Two suggestions are duplicates when
 * their target_kind, operation, target_id and NORMALIZED payload match; the first one is kept
 * (deterministic: model order). Questions about a dropped suggestion are re-pointed at the kept
 * one, and a question that then repeats one already kept is dropped too. Dropped suggestions are
 * counted, never silently lost.
 *
 * Scope is one thought on purpose: the same thing said in two thoughts of a capture is the
 * user's words, not a model glitch.
 */

import type { QuestionDraft, ResolvedSuggestion, ResolveOutcome } from './resolve'

export interface DedupeOutcome extends ResolveOutcome {
  /** Count of suggestions dropped as duplicates of a kept one. */
  duplicates: number
}

export function dedupeOutcome(outcome: ResolveOutcome): DedupeOutcome {
  const suggestions: ResolvedSuggestion[] = []
  const keptByKey = new Map<string, number>()
  // Old suggestion index → index of the kept suggestion it collapses into.
  const remap: number[] = []

  for (const s of outcome.suggestions) {
    const key = suggestionKey(s)
    const kept = keptByKey.get(key)
    if (kept !== undefined) {
      remap.push(kept)
      continue
    }
    keptByKey.set(key, suggestions.length)
    remap.push(suggestions.length)
    suggestions.push(s)
  }

  const questions: QuestionDraft[] = []
  const seenQuestions = new Set<string>()
  for (const q of outcome.questions) {
    const suggestionIndex =
      q.suggestionIndex === null ? null : (remap[q.suggestionIndex] ?? q.suggestionIndex)
    const question = { ...q, suggestionIndex }
    const key = stableStringify(normalize(question))
    if (seenQuestions.has(key)) continue
    seenQuestions.add(key)
    questions.push(question)
  }

  return {
    suggestions,
    questions,
    skipped: outcome.skipped,
    duplicates: outcome.suggestions.length - suggestions.length,
  }
}

function suggestionKey(s: ResolvedSuggestion): string {
  return stableStringify([s.target_kind, s.operation, s.target_id, normalize(s.payload)])
}

/** Case, Unicode form and whitespace are not meaningful differences in a payload's text. */
function normalize(value: unknown): unknown {
  if (typeof value === 'string')
    return value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()
  if (Array.isArray(value)) return value.map(normalize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, normalize(v)]),
    )
  }
  return value
}

/** JSON with object keys sorted, so key order never makes two payloads differ. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  )
}
