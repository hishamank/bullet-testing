/** Queue barrel — the per-job pipeline, the serial worker, and the enqueue helper. */

export { type EnqueueExtractionOpts, enqueueExtraction } from './enqueue'
export { type ProcessResult, processExtractJob } from './process'
export {
  createExtractionWorker,
  EXTRACT_BULLET_JOB,
  type ExtractionWorker,
} from './worker'
