/**
 * How similarity scores are read, per kind of embedding model. The thresholds of the slice 3 spec
 * (link at cosine 0.80, 0.75 with a shared name, an "answers" check from 0.70, a connection
 * question from 0.65) assume a DEDICATED embedding model (nomic-embed-text class). A general LLM
 * used as an embedder scores everything high (unrelated notes at 0.7–0.9), so for it the scores
 * are centred first and the thresholds are calibrated on the centred scale (docs/home-server.md
 * has the numbers).
 */

import { EMBED_BACKGROUND_SENTENCES } from './background'
import { type EmbedTemplate, JOURNAL_NOTE_TEMPLATE } from './embedder'

export interface LinkThresholds {
  /** Link two thoughts at or above this score (`same_topic` / `revisits`). */
  link: number
  /** ...or at or above this one when they name the same person, place or project. */
  linkSharedEntity: number
  /** An open loop this close to a later thought gets a yes/no/unsure "does it answer it?" check. */
  answerCheck: number
  /** From here up to the link threshold, a connection question may ask "Is this the same thing?" */
  connectionQuestion: number
  /** Below this a nightly run asks the model to confirm the link and its type. */
  reviewBelow: number
}

export interface EmbeddingProfile {
  name: 'dedicated' | 'llm'
  /** Centre vectors on a mean (background sentences + the user's thoughts) before comparing. */
  centre: boolean
  /** Wrap texts before embedding (part of the embedder key). */
  template: EmbedTemplate | null
  thresholds: LinkThresholds
}

/** The spec's numbers, for a dedicated embedding model. Raw cosine. */
export const DEDICATED_PROFILE: EmbeddingProfile = {
  name: 'dedicated',
  centre: false,
  template: null,
  thresholds: {
    link: 0.8,
    linkSharedEntity: 0.75,
    answerCheck: 0.7,
    connectionQuestion: 0.65,
    reviewBelow: 0.85,
  },
}

/**
 * A general LLM as embedder (calibrated on Qwen3.5-4B Q4_K_M, `--pooling mean`, with
 * {@link JOURNAL_NOTE_TEMPLATE}): centred cosine. On a 40-thought, 10-topic calibration set,
 * 0.40 linked 39–53% of same-topic pairs against 0.5–3.7% of unrelated ones (depending on how
 * much of the user's own journal the mean has seen); the spec's raw 0.80 on the same model
 * linked 39% against 11%.
 */
export const LLM_PROFILE: EmbeddingProfile = {
  name: 'llm',
  centre: true,
  template: JOURNAL_NOTE_TEMPLATE,
  thresholds: {
    link: 0.4,
    linkSharedEntity: 0.35,
    answerCheck: 0.3,
    connectionQuestion: 0.28,
    reviewBelow: 0.5,
  },
}

/**
 * The profile for an embedding model by its name (`EMBED_PROFILE` overrides it on the server): a
 * general LLM family (Qwen, Gemma, Llama, Mistral, Phi) is read as an LLM, anything else as a
 * dedicated embedding model (nomic-embed-text, bge, e5…), with the spec's numbers.
 */
export function profileForModel(model: string): EmbeddingProfile {
  if (/qwen3-embed|gte-qwen/i.test(model)) return DEDICATED_PROFILE
  return /qwen|gemma|llama|mistral|phi/i.test(model) ? LLM_PROFILE : DEDICATED_PROFILE
}

/** The sentences whose mean centres a fresh journal (see background.ts). */
export { EMBED_BACKGROUND_SENTENCES }
