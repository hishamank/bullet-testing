/**
 * Strongly-typed request/response shapes for the Ollama HTTP API, plus the {@link OllamaClient}
 * interface the rest of the agent depends on.
 *
 * The agent NEVER imports a concrete client — it depends on this interface (dependency
 * injection), so tests inject a scripted fake and CI never needs a live model.
 */

/** A single chat message. */
export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
}

/**
 * The `format` field controls Ollama's STRUCTURED OUTPUT. It is either the string `'json'`
 * (free-form JSON mode) or a JSON-schema object (constrained decoding to that schema). We
 * derive the JSON-schema object from a Zod schema via `zod-to-json-schema` so the schema is a
 * single source of truth (see extraction/schema.ts).
 */
export type OllamaFormat = 'json' | Record<string, unknown>

/** Per-request generation options (a loose subset; passed straight through to Ollama). */
export interface OllamaOptions {
  temperature?: number
  seed?: number
  num_ctx?: number
  [key: string]: unknown
}

/** A `/api/chat` request (non-streaming — the agent always reads a single complete response). */
export interface OllamaChatRequest {
  model: string
  messages: OllamaMessage[]
  /** Structured-output control: `'json'` or a JSON-schema object. */
  format?: OllamaFormat
  options?: OllamaOptions
}

/** The relevant fields of a `/api/chat` response. */
export interface OllamaChatResponse {
  /** The assistant message Ollama produced. */
  message: OllamaMessage
  /** The raw, fully-parsed response body (for callers that need timings/eval counts/etc.). */
  raw: Record<string, unknown>
}

/** An `/api/embed` request. `input` may be one string or many. */
export interface OllamaEmbedRequest {
  model: string
  input: string | string[]
}

/** The relevant fields of an `/api/embed` response. */
export interface OllamaEmbedResponse {
  /** One embedding vector per input (always an array of vectors, even for a single input). */
  embeddings: number[][]
  raw: Record<string, unknown>
}

/** A model as listed by `/api/tags`. */
export interface OllamaModelInfo {
  name: string
  model?: string
  size?: number
  [key: string]: unknown
}

/**
 * The Ollama client the agent depends on. A clean, mockable surface — `HttpOllamaClient` is the
 * real implementation over `fetch`; `createScriptedOllamaClient` is the test/double.
 */
export interface OllamaClient {
  /**
   * Run a chat completion. When `format` is set, Ollama constrains decoding to that JSON
   * schema (structured output). Returns the assistant message plus the raw body.
   */
  chat(req: OllamaChatRequest): Promise<OllamaChatResponse>
  /** Compute embeddings for one or many inputs; returns one vector per input. */
  embed(req: OllamaEmbedRequest): Promise<OllamaEmbedResponse>
  /** Pull (download) a model, blocking until complete. */
  pull(model: string): Promise<void>
  /** List the models available on the server (`/api/tags`). */
  listModels(): Promise<OllamaModelInfo[]>
  /** Show details for a single model (`/api/show`). */
  show(model: string): Promise<Record<string, unknown>>
}
