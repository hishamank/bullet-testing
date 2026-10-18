/**
 * Deterministic matching of a candidate against the inlined snapshot (CLAUDE.md §4.4: the LLM
 * proposes, the RESOLVER decides). The matcher does its OWN matching and does NOT depend on the
 * model emitting `referenceName` — the small model drops it stochastically, so linking must not
 * hinge on it. We match a set of deterministic signals (referenceName, the EXTRACTED entity
 * name/title from the candidate's fields, and the source span) against the snapshot's tracker
 * names / open-task titles, and return the best hit with an EXPLAINABLE score in [0, 1] (1 = best).
 *
 * The score per (query, target) is the MAX of three deterministic signals:
 *   1. exact normalised equality           → 1.0   ("Mood" ↔ "mood")
 *   2. token/prefix containment            → 0.9   ("mood" ⊆ "mood scale", "run" ↔ "running")
 *   3. the fuse.js fuzzy score (1 - fuse)  → typos/plurals/inflection ("excercise" → "exercise")
 * No LLM calls; pure and unit-testable.
 *
 * KNOWN LIMITATION (accepted v1 trade-off): deterministic stemming/containment can OVER-relate —
 * the prefix rule treats "planet" ⊇ "plan" and "carpet" ⊇ "car" as related (score 0.9), and a
 * single tracker-name token appearing incidentally in a longer span ("cleaned the water spill" vs a
 * "water" tracker) also clears containment. So the matcher occasionally proposes a false-positive
 * link. This is deliberately NOT hardened here: the resolver caps BORDERLINE links to `suggest`, and
 * value-bearing / state records are surfaced for confirmation rather than silently auto-applied (see
 * the tier rules), so an over-link becomes a suggestion the user dismisses — never silent
 * corruption. A real stemmer / embedding matcher is future work.
 */

import Fuse from 'fuse.js'
import type { Candidate } from '../extraction/schema'
import type { SnapshotTask, SnapshotTracker } from '../extraction/snapshot'

/** Tuned so close-but-not-exact names still match; the resolver decides what is "confident". */
const FUSE_OPTIONS = {
  includeScore: true,
  // 0.0 = exact only, 1.0 = match anything. 0.45 tolerates plurals/typos without wild matches.
  threshold: 0.45,
  ignoreLocation: true,
  minMatchCharLength: 2,
} as const

/** The deterministic score awarded to a token/prefix containment hit (below exact, above fuzzy). */
const CONTAINMENT_SCORE = 0.9

/** A match result: the matched row plus a normalised score in [0, 1] (1 = best). */
export interface Match<T> {
  item: T
  /** 1 = perfect match, 0 = no match. (Inverted from fuse's 0=best.) */
  score: number
}

/** Normalise a string for deterministic comparison: lowercase, trim, collapse inner whitespace. */
function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ')
}

/** The whitespace-separated tokens of an already-normalised string. */
function tokens(normalized: string): string[] {
  return normalized.split(' ').filter((t) => t !== '')
}

/**
 * Two tokens are "related" when identical OR one is a prefix of the other (both ≥ 3 chars) — a
 * deterministic, WORD-BOUNDARY-anchored inflection tolerance ("run" ↔ "running", "moods" ↔ "mood",
 * "called" ↔ "call") that avoids the false positives of free substring matching (e.g. "run" inside
 * "prune", which is not a prefix and so does NOT relate).
 */
function tokensRelated(a: string, b: string): boolean {
  if (a === b) return true
  if (Math.min(a.length, b.length) < 3) return false
  return a.startsWith(b) || b.startsWith(a)
}

/**
 * Deterministic containment score in [0, 1] between a query and a target:
 *  - normalised equality                                   → 1.0  ("Mood" ↔ "mood").
 *  - every query token related to some target token, OR    → {@link CONTAINMENT_SCORE}
 *    every target token related to some query token
 *    ("mood" ⊆ "mood scale", "called the dentist" ↔ "call the dentist", "run" ↔ "running").
 *  - otherwise                                             → 0    (defer to the fuzzy score).
 */
function containmentScore(query: string, target: string): number {
  const q = normalize(query)
  const t = normalize(target)
  if (q === '' || t === '') return 0
  if (q === t) return 1
  const qt = tokens(q)
  const tt = tokens(t)
  const queryInTarget = qt.every((x) => tt.some((y) => tokensRelated(x, y)))
  const targetInQuery = tt.every((y) => qt.some((x) => tokensRelated(x, y)))
  return queryInTarget || targetInQuery ? CONTAINMENT_SCORE : 0
}

/**
 * The deterministic strings we match a candidate against, in priority order (ALL are tried; the
 * best score wins). We do NOT depend on `referenceName` — the extracted entity name/title from the
 * (already-flattened) fields is a first-class signal, so linking survives the model dropping the
 * hint:
 *   1. `referenceName`               — the model's explicit link hint (strong, never required).
 *   2. `fields.name` / `fields.title`— the EXTRACTED entity name (the deterministic backbone).
 *   3. `text`                        — the raw source span (weakest fallback).
 * De-duplicated (a bullet often repeats the same word across signals).
 */
function candidateQueries(candidate: Candidate): string[] {
  const queries: string[] = []
  const push = (v: unknown): void => {
    if (typeof v === 'string' && v.trim() !== '') queries.push(v.trim())
  }
  push(candidate.referenceName)
  push(candidate.fields.name)
  push(candidate.fields.title)
  push(candidate.text)
  return [...new Set(queries)]
}

/**
 * Best match across `items` (keyed by `key`) for every query: per (query, item) take the MAX of the
 * deterministic containment score and the fuse fuzzy score, then the single best across all of them.
 * Returns `undefined` when nothing scores above 0 (preserving the "no match" contract).
 */
function bestMatch<T>(items: T[], key: keyof T & string, queries: string[]): Match<T> | undefined {
  if (items.length === 0 || queries.length === 0) return undefined
  const fuse = new Fuse(items, { ...FUSE_OPTIONS, keys: [key] })
  let best: Match<T> | undefined
  const consider = (item: T, score: number): void => {
    if (score <= 0) return
    if (!best || score > best.score) best = { item, score }
  }
  for (const q of queries) {
    // Deterministic exact/containment against EVERY candidate row.
    for (const item of items) {
      const target = item[key]
      if (typeof target === 'string') consider(item, containmentScore(q, target))
    }
    // Fuzzy score for typos/plurals/inflection fuse handles (0 = perfect → invert to 1 = best).
    const hit = fuse.search(q)[0]
    if (hit) consider(hit.item, 1 - (hit.score ?? 1))
  }
  return best
}

/** Best matching tracker DEFINITION for a candidate (by name), if any. */
export function matchTracker(
  candidate: Candidate,
  trackers: SnapshotTracker[],
): Match<SnapshotTracker> | undefined {
  return bestMatch(trackers, 'name', candidateQueries(candidate))
}

/** Best matching OPEN task for a candidate (by title), if any. */
export function matchOpenTask(
  candidate: Candidate,
  openTasks: SnapshotTask[],
): Match<SnapshotTask> | undefined {
  return bestMatch(openTasks, 'title', candidateQueries(candidate))
}
