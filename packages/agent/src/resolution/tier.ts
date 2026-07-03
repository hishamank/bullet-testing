/**
 * Tier assignment (CLAUDE.md §4.5) — translating a (target_kind, operation, confidence) into the
 * BEHAVIOR tier the UI surfaces: 'auto' | 'suggest' | 'ask'. The policy, documented here and in
 * the README:
 *
 *  - DEFINITION creates (target_kind ∈ DEFINITION_TARGET_KINDS, i.e. 'tracker'): NEVER 'auto',
 *    regardless of confidence — minting a definition always needs confirmation. This MATCHES
 *    @bullet/core's runtime invariant (a definition + 'auto' fails the suggestion schema), so we
 *    must never produce it. → confidence >= suggestThreshold ? 'suggest' : 'ask'.
 *
 *  - RECORDS (tracker_entry append, activity create) and instance UPDATES (task mark-done):
 *    cheap and reversible, so they MAY auto-apply when confident →
 *    confidence >= autoThreshold ? 'auto' : confidence >= suggestThreshold ? 'suggest' : 'ask'.
 *
 *  - VALUE-BEARING RECORDS (opts.valueBearing): a record that carries a VALUE — a `tracker_entry`
 *    (always: it IS a logged value) or an `activity` create carrying a `quantity`. State-derived
 *    mood/feeling readings become value-bearing tracker_entrys, so they are covered by this same
 *    rule. These are capped at 'suggest' — a wrong value or a mislinked state must never be written
 *    SILENTLY (this is exactly the eval failure tiers exist to prevent). The cap is liftable via
 *    `config.autoApplyValueRecords` (default false). TEMPORARY CONSERVATISM: until the deterministic
 *    matcher (PR #A) is proven reliable live, we never auto-apply a value; once it is, flip the flag
 *    (or promote confident links back toward 'auto'). Value-LESS records (a plain activity, no
 *    quantity) are NOT capped by this rule and stay auto-eligible.
 *
 *  - TASK CREATE: conservative — capped at 'suggest' (we do not silently mint task lists). The
 *    cap is liftable via `config.autoCreateTasks` (default false) →
 *    confidence >= suggestThreshold ? 'suggest' : 'ask'  (or the records rule when enabled).
 *
 * "Eagerness scales inversely with permanence": value-less records auto, values/tasks need a nod,
 * definitions always need a nod. The caps compose: the value cap stacks with the borderline-match
 * cap (see resolve.ts `tierForLink`) — either one alone is enough to force 'suggest'.
 */

import {
  DEFINITION_TARGET_KINDS,
  type SuggestionOperation,
  type SuggestionTier,
  type TargetKind,
} from '@bullet/core'
import type { AgentConfig } from '../config'

const isDefinitionKind = (kind: TargetKind): boolean =>
  (DEFINITION_TARGET_KINDS as readonly string[]).includes(kind)

/** The standard records/update ladder: auto → suggest → ask by the two thresholds. */
function recordTier(confidence: number, config: AgentConfig): SuggestionTier {
  if (confidence >= config.autoThreshold) return 'auto'
  if (confidence >= config.suggestThreshold) return 'suggest'
  return 'ask'
}

/** The capped ladder (never 'auto'): suggest → ask by the suggest threshold. */
function cappedTier(confidence: number, config: AgentConfig): SuggestionTier {
  return confidence >= config.suggestThreshold ? 'suggest' : 'ask'
}

/** Extra routing signals that influence the tier beyond (kind, operation, confidence). */
export interface TierOptions {
  /**
   * True when the record carries a VALUE — a `tracker_entry` (always) or an `activity` with a
   * `quantity`. Value-bearing records are capped at 'suggest' unless `config.autoApplyValueRecords`
   * opts in, so a wrong value / mislinked state is never written silently. Defaults to false.
   */
  valueBearing?: boolean
}

/**
 * Assign the behavior tier for a proposed suggestion. Pure function of the routing decision
 * (kind + operation), the model/match confidence, the config thresholds, and `opts.valueBearing`.
 */
export function assignTier(
  targetKind: TargetKind,
  operation: SuggestionOperation,
  confidence: number,
  config: AgentConfig,
  opts: TierOptions = {},
): SuggestionTier {
  // Definitions are NEVER auto (and core enforces it) — cap regardless of operation/confidence.
  if (isDefinitionKind(targetKind)) {
    return cappedTier(confidence, config)
  }

  // Task CREATE is conservative: capped unless explicitly opted in.
  if (targetKind === 'task' && operation === 'create' && !config.autoCreateTasks) {
    return cappedTier(confidence, config)
  }

  // Value-bearing records (a logged value / a quantified activity) are conservative: capped unless
  // explicitly opted in. A wrong value or a mislinked state must never be written SILENTLY.
  if (opts.valueBearing && !config.autoApplyValueRecords) {
    return cappedTier(confidence, config)
  }

  // Value-less records (tracker_entry/activity) and instance updates (mark-done) may auto-apply.
  return recordTier(confidence, config)
}
