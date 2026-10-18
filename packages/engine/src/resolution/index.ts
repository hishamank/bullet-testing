/** Resolution barrel — matching, tier assignment, and the create-vs-append resolver. */

export { DATE_ANSWER_FIELD, type DateAnswerKind, dateAnswerFields, yesNoAnswer } from './answer'
export { type DedupeOutcome, dedupeOutcome } from './dedupe'
export { type Match, matchOpenTask, matchTracker } from './match'
export {
  type QuestionDraft,
  type ResolvedSuggestion,
  type ResolveOutcome,
  resolveCandidates,
  withProvenance,
} from './resolve'
export { assignTier, type TierOptions } from './tier'
