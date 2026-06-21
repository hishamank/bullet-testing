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
import { createSuggestion, listActivities } from '@bullet/db'
import type { AgentDeps } from '../deps'

/** A proposed tracker-definition suggestion, ready to persist (provenance attached). */
export interface WeeklyProposal {
  owner_id: string
  source_bullet_id: string
  target_kind: 'tracker'
  operation: 'create'
  target_id: null
  payload: Record<string, unknown>
  confidence: number
  tier: 'suggest'
  /** The normalized activity name that triggered the proposal (for explainability/tests). */
  groupName: string
  /** How many unlinked activities shared this name. */
  count: number
}

export interface WeeklyAnalyzer {
  /** Analyze the owner's unlinked activities; return proposed tracker-definition suggestions. */
  analyze(ownerId: string): WeeklyProposal[]
  /** Persist proposals as real pending Suggestions (tier 'suggest', never auto). */
  persist(proposals: WeeklyProposal[]): Suggestion[]
}

export interface WeeklyAnalyzerOptions {
  /** Minimum count of same-named unlinked activities to propose a tracker (default 3). */
  threshold?: number
}

/** Normalize an activity name for grouping (lowercase, collapse whitespace, trim). */
function normalizeName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Create a weekly analyzer bound to `deps`. The threshold is configurable (default 3).
 */
export function createWeeklyAnalyzer(
  deps: AgentDeps,
  options: WeeklyAnalyzerOptions = {},
): WeeklyAnalyzer {
  const threshold = options.threshold ?? 3

  return {
    analyze(ownerId: string): WeeklyProposal[] {
      // Group active UNLINKED activities by normalized name.
      const groups = new Map<
        string,
        { displayName: string; count: number; sourceBulletId: string }
      >()

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

      const proposals: WeeklyProposal[] = []
      for (const [key, group] of groups) {
        if (group.count < threshold) continue
        proposals.push({
          owner_id: ownerId,
          source_bullet_id: group.sourceBulletId,
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

    persist(proposals: WeeklyProposal[]): Suggestion[] {
      return proposals.map((p) =>
        createSuggestion(deps.db, {
          owner_id: p.owner_id,
          source_bullet_id: p.source_bullet_id,
          target_kind: p.target_kind,
          operation: p.operation,
          target_id: p.target_id,
          // The apply engine re-validates the payload against the tracker INSERT schema, which
          // requires owner_id + source_bullet_id present; inject them (apply forces them anyway).
          payload: {
            ...p.payload,
            owner_id: p.owner_id,
            source_bullet_id: p.source_bullet_id,
          },
          confidence: p.confidence,
          tier: p.tier,
          resolved_at: null,
        }),
      )
    },
  }
}
