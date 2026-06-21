/**
 * persistAndAutoApply — the canonical "persist a resolved draft, then auto-apply if tier 'auto'"
 * policy, extracted so the main extraction pipeline (queue/process.ts) and reconciliation
 * (reconcile/reconcile.ts) cannot drift on it.
 *
 * For one {@link ResolvedSuggestion} draft it:
 *   1. persists it as a Suggestion with PROVENANCE (`withProvenance` → `createSuggestion`), then
 *   2. if the persisted suggestion is tier 'auto', tries to apply it via `acceptSuggestion`.
 *
 * Auto-apply is FAIL-SOFT: `acceptSuggestion` RE-VALIDATES against live state, so a stale apply
 * (e.g. the target was deleted between persist and apply) fails the apply only — the suggestion
 * stays pending (degrades to a normal suggestion) rather than throwing. We RECORD that failure on
 * the result (`failed`) instead of swallowing it, so callers can surface it (result + SSE event).
 */

import { acceptSuggestion, createSuggestion } from '@bullet/db'
import type { AgentDeps } from './deps'
import { type ResolvedSuggestion, withProvenance } from './resolution/resolve'

/** The outcome of persisting one draft and (when tier 'auto') attempting to apply it. */
export interface PersistOutcome {
  /** The id of the persisted Suggestion (always present — persistence itself does not fail soft). */
  id: string
  /** True iff the suggestion was tier 'auto' AND its auto-apply succeeded. */
  applied: boolean
  /** True iff the suggestion was tier 'auto' but its auto-apply FAILED (stays pending, fail-soft). */
  failed: boolean
}

/**
 * Persist `draft` (attaching `ownerId`/`bulletId` provenance) and auto-apply it when tier 'auto'.
 * See the module doc for the fail-soft contract. Returns `{ id, applied, failed }` so the caller
 * accumulates the id/applied/failed arrays however it likes.
 */
export function persistAndAutoApply(
  deps: AgentDeps,
  draft: ResolvedSuggestion,
  ownerId: string,
  bulletId: string,
): PersistOutcome {
  const suggestion = createSuggestion(deps.db, withProvenance(draft, ownerId, bulletId))
  if (suggestion.tier !== 'auto') {
    return { id: suggestion.id, applied: false, failed: false }
  }
  try {
    acceptSuggestion(deps.db, suggestion.id)
    return { id: suggestion.id, applied: true, failed: false }
  } catch {
    // Leave it pending; a record that no longer applies cleanly becomes a normal suggestion.
    return { id: suggestion.id, applied: false, failed: true }
  }
}
