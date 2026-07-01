/**
 * Weekly analysis (STUB) — a trivial-but-real pattern detector. It scans the owner's active
 * UNLINKED activities (`tracker_id === null`), groups them by normalized name, and for any group
 * whose count meets a threshold proposes a Tracker DEFINITION suggestion ("you keep logging
 * 'meditate' — want a tracker for it?"). Definitions are NEVER auto, so the tier is 'suggest'.
 *
 * v1 keeps this deliberately simple — full pattern detection (clustering, cadence, value
 * inference) is later. The analyzer RETURNS the proposed suggestions; a `persist()` helper is
 * provided for callers that want them stored. Each proposal carries provenance from a member
 * activity's `source_bullet_id` (a Suggestion requires a non-null source bullet).
 */

import type { Suggestion } from '@bullet/core'
import { createSuggestion, listActivities, listSuggestionsByStatus, listTrackers } from '@bullet/db'
import type { AgentDeps } from '../deps'
import { type ResolvedSuggestion, withProvenance } from '../resolution/resolve'

/**
 * A proposed tracker-definition suggestion: the canonical {@link ResolvedSuggestion} draft (so it
 * carries the SAME target_kind/operation/target_id/payload/confidence/tier shape and tier rules as
 * the main pipeline — and persists through the SAME `withProvenance`) plus two report fields for
 * explainability/tests. Provenance (owner_id/source_bullet_id) is NOT carried on the draft: like
 * every other resolved suggestion it is attached at persist time, travelling as ARGUMENTS into
 * `withProvenance` (the owner from `analyze(ownerId)`, the source bullet from the group it scanned)
 * — exactly mirroring the main pipeline's `persistAndAutoApply(deps, draft, ownerId, bulletId)`.
 */
export interface WeeklyProposal extends ResolvedSuggestion {
  /** The normalized activity name that triggered the proposal (for explainability/tests). */
  groupName: string
  /** How many unlinked activities shared this name. */
  count: number
}

export interface WeeklyAnalyzer {
  /** Analyze the owner's unlinked activities; return proposed tracker-definition suggestions. */
  analyze(ownerId: string): WeeklyProposal[]
  /**
   * Persist proposals as real pending Suggestions (tier 'suggest', never auto). Provenance travels
   * as ARGUMENTS, off the draft: the `ownerId` (the same one `analyze` ran for) plus, per proposal,
   * the source bullet of the group it was built from — recovered here from the owner's activities.
   */
  persist(ownerId: string, proposals: WeeklyProposal[]): Suggestion[]
}

export interface WeeklyAnalyzerOptions {
  /** Minimum count of same-named unlinked activities to propose a tracker (default 3). */
  threshold?: number
}

/** Normalize an activity name for grouping (lowercase, collapse whitespace, trim). */
function normalizeName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** A grouped run of same-named unlinked activities (the unit a proposal is built from). */
interface ActivityGroup {
  displayName: string
  count: number
  /** The group's provenance anchor — the latest non-null source bullet among its members. */
  sourceBulletId: string
}

/**
 * Group the owner's active UNLINKED activities by normalized name, keyed by that name. Only groups
 * attributable to a source bullet are kept (a Suggestion needs a non-null source bullet). This is
 * the single source for BOTH the proposals (`analyze`) and their persist-time provenance (`persist`
 * recovers each group's `sourceBulletId` here), so the two can never disagree on the anchor bullet.
 */
function groupUnlinkedActivities(deps: AgentDeps, ownerId: string): Map<string, ActivityGroup> {
  const groups = new Map<string, ActivityGroup>()
  for (const activity of listActivities(deps.db, ownerId)) {
    if (activity.tracker_id !== null) continue // already linked → not a candidate.
    const key = normalizeName(activity.name)
    if (key === '') continue
    const existing = groups.get(key)
    if (existing) {
      existing.count += 1
      // Keep the latest non-null source bullet as provenance anchor.
      if (activity.source_bullet_id) existing.sourceBulletId = activity.source_bullet_id
    } else if (activity.source_bullet_id) {
      // Only seed a group we can attribute to a bullet (a Suggestion needs a source bullet).
      groups.set(key, {
        displayName: activity.name.trim(),
        count: 1,
        sourceBulletId: activity.source_bullet_id,
      })
    }
  }
  return groups
}

/**
 * Normalized tracker names already "claimed" for this owner, so `analyze` won't re-propose them.
 * A name is claimed by ANY of:
 *  - an active tracker DEFINITION (`listTrackers`) — the pattern is already tracked;
 *  - a still-PENDING tracker-kind Suggestion — avoids DUPLICATE proposals on a re-run;
 *  - a REJECTED tracker-kind Suggestion — the user explicitly said no, so a manual re-run must
 *    NOT resurface it (rejecting only flips status to 'rejected'; it creates no tracker, so
 *    without this the proposal would come back on the next "Run weekly review").
 * Kept pure-read: it only queries via the repos and uses the SAME `normalizeName` the grouping
 * does, so the two can never disagree on a name.
 */
function claimedTrackerNames(deps: AgentDeps, ownerId: string): Set<string> {
  const claimed = new Set<string>()
  for (const tracker of listTrackers(deps.db, ownerId)) {
    claimed.add(normalizeName(tracker.name))
  }
  // Pending AND rejected tracker-kind suggestions both suppress a re-proposal (the latter so a
  // user's explicit "no" sticks across runs).
  for (const status of ['pending', 'rejected'] as const) {
    for (const suggestion of listSuggestionsByStatus(deps.db, ownerId, status)) {
      // Claims ANY tracker-kind suggestion regardless of `operation` — moot in v1 (tracker
      // suggestions are create-only); flagged so a future tracker-`update` path doesn't silently
      // start suppressing proposals.
      if (suggestion.target_kind !== 'tracker') continue
      const name = suggestion.payload.name
      if (typeof name === 'string') claimed.add(normalizeName(name))
    }
  }
  return claimed
}

/**
 * Create a weekly analyzer bound to `deps`. The threshold is configurable (default 3).
 *
 * NOTE: analyze+persist is NOT atomic across a run — fine for the single-user MANUAL trigger
 * (`analyze` is a pure read; the UI disables the button while running); a future scheduler or
 * multi-user path should wrap the two in one transaction.
 */
export function createWeeklyAnalyzer(
  deps: AgentDeps,
  options: WeeklyAnalyzerOptions = {},
): WeeklyAnalyzer {
  const threshold = options.threshold ?? 3

  return {
    analyze(ownerId: string): WeeklyProposal[] {
      // Idempotency guard: skip a name already backed by an active tracker, a pending tracker
      // suggestion, or a rejected one — so a re-run proposes nothing new and never resurfaces a
      // proposal the user already dismissed.
      const claimed = claimedTrackerNames(deps, ownerId)
      const proposals: WeeklyProposal[] = []
      for (const [key, group] of groupUnlinkedActivities(deps, ownerId)) {
        if (group.count < threshold) continue
        if (claimed.has(key)) continue
        proposals.push({
          target_kind: 'tracker',
          operation: 'create',
          target_id: null,
          payload: {
            name: group.displayName,
            // A boolean "did I do it" tracker is the safe default for an activity pattern.
            input_type: 'boolean',
            config: { input_type: 'boolean' },
          },
          // Moderate confidence: a heuristic count, not a model judgment.
          confidence: 0.6,
          // Definitions are NEVER auto (CLAUDE.md §4.5).
          tier: 'suggest',
          groupName: key,
          count: group.count,
        })
      }
      return proposals
    },

    persist(ownerId: string, proposals: WeeklyProposal[]): Suggestion[] {
      // Provenance travels as ARGUMENTS, off the draft — identical to the main pipeline. The owner
      // is the one `analyze` ran for; the source bullet is recovered per proposal from the SAME
      // grouping `analyze` used (matched by `groupName`), then both are injected exactly once via
      // the canonical `withProvenance`, so weekly can never drift from the tier/provenance rules.
      const groups = groupUnlinkedActivities(deps, ownerId)
      return proposals.map((p) => {
        const sourceBulletId = groups.get(p.groupName)?.sourceBulletId
        if (!sourceBulletId) {
          throw new Error(`weekly: no source bullet for proposal group "${p.groupName}"`)
        }
        return createSuggestion(deps.db, withProvenance(p, ownerId, sourceBulletId))
      })
    },
  }
}
