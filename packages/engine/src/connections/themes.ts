/**
 * Themes (slice 3), as pure decisions for the nightly run:
 *
 *  - a CLUSTER is a connected group of linked thoughts from the last 30 days;
 *  - it is a THEME when it has ≥ 4 thoughts over ≥ 3 distinct days (each capture's own local
 *    day) from ≥ 2 captures ({@link CONNECTION_RULES});
 *  - each theme-sized cluster is matched to the theme it shares most thoughts with. A theme the
 *    user merged away is followed to the theme it lives in now (its alias). A cluster half or
 *    more made of the thoughts of a theme the user called "Not a theme" is never a theme again;
 *  - at most 8 are active: the biggest, then the most recent.
 */

import { CONNECTION_RULES } from '@bullet/core'
import { zonedParts } from '../time/zoned'
import { sharedEntity } from './entities'
import { dot, type Vector } from './vector'

export interface ThemeCandidateThought {
  id: string
  bulletId: string
  /** The capture's time and zone (its local day is what counts). */
  capturedAt: number
  timezone: string
  sensitive: boolean
}

/** Connected groups (of 2 or more) of `thoughts`, joined by `edges` between them. */
export function clusterThoughts(
  thoughts: readonly ThemeCandidateThought[],
  edges: readonly (readonly [string, string])[],
): ThemeCandidateThought[][] {
  const byId = new Map(thoughts.map((t) => [t.id, t]))
  const parent = new Map<string, string>(thoughts.map((t) => [t.id, t.id]))
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r) as string
    let c = x
    while (parent.get(c) !== r) {
      const next = parent.get(c) as string
      parent.set(c, r)
      c = next
    }
    return r
  }
  for (const [a, b] of edges) {
    if (!byId.has(a) || !byId.has(b)) continue
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb)
  }
  const groups = new Map<string, ThemeCandidateThought[]>()
  for (const t of thoughts) {
    const r = find(t.id)
    groups.set(r, [...(groups.get(r) ?? []), t])
  }
  return [...groups.values()]
    .filter((g) => g.length >= 2)
    .map((g) => g.sort((a, b) => a.capturedAt - b.capturedAt || (a.id < b.id ? -1 : 1)))
}

/** A capture's local calendar day, "YYYY-MM-DD". */
export function localDay(epochMs: number, timezone: string): string {
  const p = zonedParts(epochMs, timezone)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

/** Calendar days from the first to the last thought, both included (≥ 1). */
export function daySpan(members: readonly ThemeCandidateThought[]): number {
  if (members.length === 0) return 1
  const first = members.reduce((a, b) => (b.capturedAt < a.capturedAt ? b : a))
  const last = members.reduce((a, b) => (b.capturedAt > a.capturedAt ? b : a))
  const toUtc = (t: ThemeCandidateThought) => {
    const p = zonedParts(t.capturedAt, t.timezone)
    return Date.UTC(p.year, p.month - 1, p.day)
  }
  return Math.max(1, Math.round((toUtc(last) - toUtc(first)) / 86_400_000) + 1)
}

export interface ClusterStats {
  count: number
  /** Distinct local days. */
  days: number
  captures: number
  firstAt: number
  lastAt: number
  /** Share of sensitive thoughts (0–1). */
  sensitiveShare: number
}

export function clusterStats(members: readonly ThemeCandidateThought[]): ClusterStats {
  const days = new Set(members.map((m) => localDay(m.capturedAt, m.timezone)))
  const captures = new Set(members.map((m) => m.bulletId))
  const times = members.map((m) => m.capturedAt)
  return {
    count: members.length,
    days: days.size,
    captures: captures.size,
    firstAt: times.length ? Math.min(...times) : 0,
    lastAt: times.length ? Math.max(...times) : 0,
    sensitiveShare: members.length ? members.filter((m) => m.sensitive).length / members.length : 0,
  }
}

/** ≥ 4 thoughts over ≥ 3 distinct days from ≥ 2 captures. */
export function qualifiesAsTheme(s: ClusterStats): boolean {
  const r = CONNECTION_RULES
  return s.count >= r.minThoughts && s.days >= r.minDays && s.captures >= r.minCaptures
}

/** Too sensitive to surface: no card, no name, not on the phone. */
export function isSensitiveTheme(share: number): boolean {
  return share >= CONNECTION_RULES.sensitiveShare
}

export interface KnownTheme {
  id: string
  status: 'active' | 'dormant' | 'retired'
  /** Why it was retired: the user's "Not a theme", or a merge. */
  retiredBy: 'user' | 'merge' | null
  /** Merged themes: the survivor. */
  mergedInto: string | null
  /** Thoughts it holds (for a merged theme: those it held before the merge). */
  members: ReadonlySet<string>
  /** "Not a theme": the thoughts it held then (never a theme again from mostly these). */
  vetoed: ReadonlySet<string>
  lastSeenAt: number | null
}

export interface ClusterAssignment {
  members: ThemeCandidateThought[]
  stats: ClusterStats
  /** The theme it continues; null for a new one. */
  themeId: string | null
}

/** Follow merges to the theme a merged one lives in now (null if that was retired by the user). */
export function resolveAlias(
  themeId: string,
  themes: ReadonlyMap<string, KnownTheme>,
): string | null {
  let id = themeId
  for (let hops = 0; hops < 20; hops++) {
    const t = themes.get(id)
    if (!t) return null
    if (t.retiredBy === 'user') return null
    if (t.retiredBy !== 'merge' || t.mergedInto === null) return id
    id = t.mergedInto
  }
  return null
}

/**
 * Match theme-sized clusters (biggest first) to known themes: the theme holding most of the
 * cluster's thoughts, else the one most of them are linked to (`neighbours`: a topic coming back
 * after the 30-day window continues its old theme). Merged themes are followed to their survivor.
 * A cluster half or more made of a "Not a theme" theme's thoughts is dropped. Clusters landing on
 * the same theme (two topics the user merged) are one theme.
 */
export function matchClusters(
  clusters: readonly ThemeCandidateThought[][],
  known: readonly KnownTheme[],
  neighbours: (thoughtId: string) => readonly string[] = () => [],
): ClusterAssignment[] {
  const themes = new Map(known.map((t) => [t.id, t]))
  const sized = clusters
    .map((members) => ({ members, stats: clusterStats(members) }))
    .filter((c) => qualifiesAsTheme(c.stats))
    .sort((a, b) => b.stats.count - a.stats.count || b.stats.lastAt - a.stats.lastAt)
  const byTheme = new Map<string, ThemeCandidateThought[]>()
  const fresh: ClusterAssignment[] = []
  for (const c of sized) {
    const ids = c.members.map((m) => m.id)
    const vetoed = known.some(
      (t) =>
        t.retiredBy === 'user' && ids.filter((id) => t.vetoed.has(id)).length * 2 >= ids.length,
    )
    if (vetoed) continue
    const pick = (score: (t: KnownTheme) => number): string | null => {
      let best: { id: string; score: number; lastSeenAt: number } | null = null
      for (const t of known) {
        const sc = score(t)
        if (sc === 0) continue
        const target = resolveAlias(t.id, themes)
        if (target === null) continue
        const lastSeenAt = themes.get(target)?.lastSeenAt ?? 0
        if (!best || sc > best.score || (sc === best.score && lastSeenAt > best.lastSeenAt)) {
          best = { id: target, score: sc, lastSeenAt }
        }
      }
      return best?.id ?? null
    }
    const themeId =
      pick((t) => ids.filter((id) => t.members.has(id)).length) ??
      pick((t) => ids.filter((id) => neighbours(id).some((n) => t.members.has(n))).length)
    if (themeId === null) {
      fresh.push({ ...c, themeId: null })
      continue
    }
    const into = byTheme.get(themeId) ?? []
    for (const m of c.members) if (!into.some((x) => x.id === m.id)) into.push(m)
    byTheme.set(themeId, into)
  }
  const continued = [...byTheme.entries()].map(([themeId, members]) => ({
    members,
    stats: clusterStats(members),
    themeId,
  }))
  return [...continued, ...fresh]
}

/**
 * The edges themes are found on: every pair of `thoughts` at or above `threshold` (or
 * `sharedThreshold` when both name the same person, place or project), minus vetoed pairs, plus
 * the given links (the user's own and answers). Unlike links, not capped per thought: a topic that
 * keeps coming back stays one cluster however many times it came up.
 */
export function similarityEdges(
  thoughts: readonly { id: string; vector: Vector | null; entities: readonly string[] }[],
  thresholds: { link: number; linkSharedEntity: number },
  vetoed: (a: string, b: string) => boolean,
  extra: readonly (readonly [string, string])[] = [],
  /** Only rows `from` ≤ i < `to` (to split the O(n²) work into chunks); the extra edges come with row 0. */
  rows: readonly [number, number] = [0, thoughts.length],
): [string, string][] {
  const edges: [string, string][] = rows[0] === 0 ? extra.map(([a, b]) => [a, b]) : []
  for (let i = rows[0]; i < Math.min(rows[1], thoughts.length); i++) {
    const x = thoughts[i] as (typeof thoughts)[number]
    if (!x.vector) continue
    for (let j = i + 1; j < thoughts.length; j++) {
      const y = thoughts[j] as (typeof thoughts)[number]
      if (!y.vector) continue
      const score = dot(x.vector, y.vector)
      const min = sharedEntity(x.entities, y.entities)
        ? thresholds.linkSharedEntity
        : thresholds.link
      if (score >= min && !vetoed(x.id, y.id)) edges.push([x.id, y.id])
    }
  }
  return edges
}

/**
 * The assignments that make the active themes: at most `max` that can be shown, biggest then most
 * recent. A mostly-sensitive theme is never shown, so it never takes one of those slots (it stays
 * tracked on the server).
 */
export function pickActive<T extends { stats: ClusterStats }>(
  assignments: readonly T[],
  max: number = CONNECTION_RULES.maxActiveThemes,
): T[] {
  const sorted = [...assignments].sort(
    (a, b) => b.stats.count - a.stats.count || b.stats.lastAt - a.stats.lastAt,
  )
  const hidden = (a: T) => isSensitiveTheme(a.stats.sensitiveShare)
  return [...sorted.filter((a) => !hidden(a)).slice(0, max), ...sorted.filter(hidden)]
}

export interface QuotableThought {
  id: string
  bulletId: string
  text: string
  capturedAt: number
  sensitive: boolean
  vector: Vector | null
}

/**
 * A Noticed card's quotes: up to `max` non-sensitive thoughts, one per capture where possible,
 * newest first; and the headline quote, the thought closest to all the others (the most typical
 * way the user said it), which is always one of the quotes.
 */
export function pickQuotes(
  members: readonly QuotableThought[],
  max = 3,
): { headline: QuotableThought; quotes: QuotableThought[] } | null {
  const usable = members.filter((m) => !m.sensitive && m.text.trim() !== '')
  if (usable.length === 0) return null
  const central = (m: QuotableThought) => {
    const v = m.vector
    if (v === null) return 0
    return usable.reduce((s, o) => (o === m || o.vector === null ? s : s + dot(v, o.vector)), 0)
  }
  const headline = [...usable].sort(
    (a, b) => central(b) - central(a) || a.text.length - b.text.length,
  )[0] as QuotableThought
  const newest = [...usable].sort((a, b) => b.capturedAt - a.capturedAt)
  const quotes: QuotableThought[] = []
  const captures = new Set<string>()
  for (const m of newest) {
    if (quotes.length >= max) break
    if (captures.has(m.bulletId)) continue
    captures.add(m.bulletId)
    quotes.push(m)
  }
  for (const m of newest) {
    if (quotes.length >= max) break
    if (!quotes.includes(m)) quotes.push(m)
  }
  // The headline always quotes one of the quotes (what hides a quote must hide the headline too).
  if (!quotes.includes(headline)) quotes[Math.min(quotes.length, max) - 1] = headline
  return { headline, quotes }
}
