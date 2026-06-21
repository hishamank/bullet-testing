/** Extraction barrel — snapshot, schema, prompt, and the extractor. */

export { extractCandidates } from './extract'
export { buildExtractionPrompt, EXTRACTION_SYSTEM_PROMPT } from './prompt'
export {
  type Candidate,
  candidateSchema,
  type ExtractionResponse,
  extractionJsonSchema,
  extractionResponseSchema,
  type Orientation,
  orientationSchema,
} from './schema'
export {
  buildSnapshot,
  type ExtractionSnapshot,
  type SnapshotTask,
  type SnapshotTracker,
} from './snapshot'
