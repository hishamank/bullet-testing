/** Connections (slice 3): embeddings, links between thoughts, themes, the nightly model calls. */

export {
  applyTemplate,
  createOpenAiCompatibleEmbedder,
  createScriptedEmbedder,
  type Embedder,
  embedderKey,
  type EmbedTemplate,
  JOURNAL_NOTE_TEMPLATE,
  type OpenAiCompatibleEmbedderOptions,
  type ScriptedEmbedder,
  withEmbedTimeout,
} from './embedder'
export {
  centre,
  combineMeans,
  cosine,
  decodeVector,
  dot,
  encodeVector,
  meanOf,
  normalize,
  type Scored,
  topK,
  type Vector,
  type VectorMean,
} from './vector'
export {
  DEDICATED_PROFILE,
  EMBED_BACKGROUND_SENTENCES,
  type EmbeddingProfile,
  type LinkThresholds,
  LLM_PROFILE,
  profileForModel,
} from './profile'
export { cleanEntities, normalizeEntity, sharedEntity } from './entities'
export {
  type AnswerCheck,
  capLinks,
  type LinkableThought,
  type LinkPlan,
  type LinkProposal,
  linkTypeFor,
  planLinks,
  type PlanLinksInput,
  type QuestionCandidate,
} from './links'
export {
  ANSWER_CHECK_SYSTEM_PROMPT,
  answerCheck,
  type AnswerVerdict,
  fallbackThemeName,
  LINK_REVIEW_SYSTEM_PROMPT,
  type LinkReview,
  nameTheme,
  reviewLink,
  THEME_NAME_SYSTEM_PROMPT,
  validThemeName,
} from './judge'
export {
  type ClusterAssignment,
  type ClusterStats,
  clusterStats,
  clusterThoughts,
  daySpan,
  isSensitiveTheme,
  type KnownTheme,
  localDay,
  matchClusters,
  pickActive,
  pickQuotes,
  type QuotableThought,
  qualifiesAsTheme,
  resolveAlias,
  similarityEdges,
  type ThemeCandidateThought,
} from './themes'
