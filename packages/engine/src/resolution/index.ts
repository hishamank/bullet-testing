/** Resolution barrel — matching, tier assignment, and the create-vs-append resolver. */

export { DATE_ANSWER_FIELD, type DateAnswerKind, dateAnswerFields, yesNoAnswer } from './answer'
export { type DedupeOutcome, dedupeOutcome } from './dedupe'
export { type Match, matchOpenTask, matchTracker } from './match'
export {
  type QuestionDraft,
  type ResolvedSuggestion,
  type ResolveOutcome,
  readingAsActivity,
  resolveCandidates,
  startTrackingQuestion,
  type ThoughtContext,
  withProvenance,
} from './resolve'
export { isKnownMeasure, trackerAlias, trackerName, trackerNounFrom } from './naming'
export { cleanTitle, stripTrailingPunctuation, stripWhenPhrases } from './title'
export {
  convertDuration,
  normalizeUnit,
  type Reading,
  readingFromFields,
  readingFromText,
} from './reading'
export { assignTier, type TierOptions } from './tier'
