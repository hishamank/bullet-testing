/** Extraction barrel — snapshot, schema, prompt, and the extractor. */

export { extractCandidates, extractJsonObject, type ExtractionInput } from './extract'
export { buildExtractionPrompt, EXTRACTION_SYSTEM_PROMPT, renderCaptureContext } from './prompt'
export {
  type Candidate,
  candidateSchema,
  type ExtractionResponse,
  extractionJsonSchema,
  extractionResponseSchema,
  type Orientation,
  orientationSchema,
} from './schema'
export { type ExtractionSnapshot, type SnapshotTask, type SnapshotTracker } from './snapshot'
