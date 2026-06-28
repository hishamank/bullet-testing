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
 *  - TASK CREATE: conservative — capped at 'suggest' (we do not silently mint task lists). The
 *    cap is liftable via `config.autoCreateTasks` (default false) →
 *    confidence >= suggestThreshold ? 'suggest' : 'ask'  (or the records rule when enabled).
 *
 * "Eagerness scales inversely with permanence": records auto, tasks need a nod, definitions
 * always need a nod.
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

/**
 * Assign the behavior tier for a proposed suggestion. Pure function of the routing decision
 * (kind + operation), the model/match confidence, and the config thresholds.
 */
export function assignTier(
  targetKind: TargetKind,
  operation: SuggestionOperation,
  confidence: number,
  config: AgentConfig,
): SuggestionTier {
  // Definitions are NEVER auto (and core enforces it) — cap regardless of operation/confidence.
  if (isDefinitionKind(targetKind)) {
    return cappedTier(confidence, config)
  }

  // Task CREATE is conservative: capped unless explicitly opted in.
  if (targetKind === 'task' && operation === 'create' && !config.autoCreateTasks) {
    return cappedTier(confidence, config)
  }

  // Records (tracker_entry/activity) and instance updates (task mark-done) may auto-apply.
  return recordTier(confidence, config)
}
