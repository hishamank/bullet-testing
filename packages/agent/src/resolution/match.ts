/**
 * Fuzzy/alias matching of a candidate against the inlined snapshot, using fuse.js. The candidate
 * carries a `referenceName` (the model's attempt to name an existing definition/instance) and a
 * `text` span; we match BOTH against the snapshot's tracker names and open-task titles, and
 * return the best hit with an EXPLAINABLE score in [0, 1] (1 = perfect).
 *
 * fuse.js scores 0 = perfect, 1 = no match; we invert to `1 - fuseScore` so larger = better and
 * it composes cleanly with the model's confidence (see resolve.ts).
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

/** A match result: the matched row plus a normalised score in [0, 1] (1 = best). */
export interface Match<T> {
  item: T
  /** 1 = perfect match, 0 = no match. (Inverted from fuse's 0=best.) */
  score: number
}

/** The strings on a candidate we try to match (referenceName first, then the source span). */
function candidateQueries(candidate: Candidate): string[] {
  const queries: string[] = []
  if (candidate.referenceName && candidate.referenceName.trim() !== '') {
    queries.push(candidate.referenceName.trim())
  }
  if (candidate.text && candidate.text.trim() !== '') {
    queries.push(candidate.text.trim())
  }
  return queries
}

/** Run fuse over `items` (keyed by `key`) for every query, returning the single best hit. */
function bestMatch<T>(items: T[], key: keyof T & string, queries: string[]): Match<T> | undefined {
  if (items.length === 0 || queries.length === 0) return undefined
  const fuse = new Fuse(items, { ...FUSE_OPTIONS, keys: [key] })
  let best: Match<T> | undefined
  for (const q of queries) {
    const hit = fuse.search(q)[0]
    if (!hit) continue
    // fuse score: 0 = perfect, 1 = worst. Invert so 1 = best.
    const score = 1 - (hit.score ?? 1)
    if (!best || score > best.score) best = { item: hit.item, score }
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
