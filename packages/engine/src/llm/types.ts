/**
 * The provider-neutral LLM client the engine depends on.
 *
 * The engine never imports a concrete client. The server injects one (an OpenAI-compatible
 * adapter for llama.cpp's `llama-server`); tests inject {@link createScriptedLlmClient}, so CI
 * never needs a live model.
 */

/** A single chat message. */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** A non-streaming chat completion request. */
export interface LlmChatRequest {
  model: string
  messages: LlmMessage[]
  /**
   * Structured output: a JSON-schema object the response must satisfy. Adapters map this to the
   * provider's mechanism (llama-server: `response_format: { type: 'json_schema', ... }`).
   */
  jsonSchema?: Record<string, unknown>
  temperature?: number
  seed?: number
}

/** The relevant fields of a chat completion response. */
export interface LlmChatResponse {
  /** The assistant message the model produced. */
  message: LlmMessage
  /** The raw, parsed response body (timings, token counts, …) for callers that need it. */
  raw: Record<string, unknown>
}

export interface LlmClient {
  chat(req: LlmChatRequest): Promise<LlmChatResponse>
}
