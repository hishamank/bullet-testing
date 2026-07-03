/** Resolution barrel — matching, tier assignment, and the create-vs-append resolver. */

export { type Match, matchOpenTask, matchTracker } from './match'
export {
  type ResolvedSuggestion,
  type ResolveOutcome,
  resolveCandidates,
  withProvenance,
} from './resolve'
export { assignTier, type TierOptions } from './tier'
