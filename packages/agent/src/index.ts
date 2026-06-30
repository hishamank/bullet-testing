/**
 * @bullet/agent — "the brain".
 *
 * The Ollama client (structured-output chat, embeddings, model pull/status), the
 * extraction → resolution → suggestion pipeline, the SERIAL inference queue (single GPU slot),
 * reconciliation (§4.7), and the weekly-analysis stub. Depends ONLY on @bullet/core + @bullet/db
 * (+ fuse.js / zod / zod-to-json-schema).
 *
 * Everything is plain functions over an injected `deps` bundle (`{ db, ollama, config, emitter }`),
 * so the whole pipeline is testable with an in-memory db (`createTestDb`) and a scripted Ollama
 * client. The Ollama client is ALWAYS mocked in tests — CI never needs a live model. A future
 * tRPC server is a thin wrapper around `createAgentRuntime`.
 */

export const PACKAGE_NAME = '@bullet/agent'

// Config.
export {
  AGENT_CONFIG_DEFAULTS,
  type AgentConfig,
  type AgentEnv,
  loadAgentConfig,
} from './config'
// Deps bundle (dependency injection).
export type { AgentDeps } from './deps'
// Typed errors.
export { AgentError, type AgentErrorCode } from './errors'
// Typed event emitter (SSE source for the server).
export {
  type AgentEmitter,
  type AgentEvents,
  createAgentEmitter,
  type ExtractionCompleteEvent,
  type ExtractionErrorEvent,
} from './events'
// Extraction.
export {
  buildExtractionPrompt,
  buildSnapshot,
  type Candidate,
  candidateSchema,
  EXTRACTION_SYSTEM_PROMPT,
  type ExtractionResponse,
  type ExtractionSnapshot,
  extractCandidates,
  extractionJsonSchema,
  extractionResponseSchema,
  type Orientation,
  orientationSchema,
  type SnapshotTask,
  type SnapshotTracker,
} from './extraction'
// Ollama health probe (server boot preflight + tRPC query + web "model offline" banner).
export { checkOllamaHealth, type OllamaHealth } from './health'
// Ollama client (interface + HTTP impl + scripted fake).
export {
  type ChatHandler,
  type ChatScriptValue,
  createScriptedOllamaClient,
  type EmbedHandler,
  type EmbedScriptValue,
  HttpOllamaClient,
  type HttpOllamaClientOptions,
  type OllamaChatRequest,
  type OllamaChatResponse,
  type OllamaClient,
  type OllamaEmbedRequest,
  type OllamaEmbedResponse,
  type OllamaFormat,
  type OllamaMessage,
  type OllamaModelInfo,
  type OllamaOptions,
  type OllamaScript,
  type RecordedCall,
  type ScriptedOllamaClient,
} from './ollama'
// Queue (per-job pipeline, serial worker, enqueue helper).
export {
  createExtractionWorker,
  type EnqueueExtractionOpts,
  EXTRACT_BULLET_JOB,
  type ExtractionWorker,
  enqueueExtraction,
  type ProcessResult,
  processExtractJob,
} from './queue'
// Reconciliation (§4.7).
export { type ReconcileResult, reprocessBullet } from './reconcile'
// Resolution (matching, tier, the create-vs-append resolver).
export {
  assignTier,
  type Match,
  matchOpenTask,
  matchTracker,
  type ResolvedSuggestion,
  type ResolveOutcome,
  resolveCandidates,
  withProvenance,
} from './resolution'
// Runtime factory (wires everything for the Task 4 server).
export {
  type AgentRuntime,
  type AgentRuntimeOptions,
  createAgentRuntime,
} from './runtime'
// Weekly-analysis stub.
export {
  createWeeklyAnalyzer,
  type WeeklyAnalyzer,
  type WeeklyAnalyzerOptions,
  type WeeklyProposal,
} from './weekly'
