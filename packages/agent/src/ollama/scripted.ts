/**
 * A scripted FAKE {@link OllamaClient} — for the agent's own tests AND for Task 4's server
 * integration test, so the whole pipeline runs end-to-end without a live model.
 *
 * Two ways to script a response, per method:
 *   - a HANDLER function `(req) => response` (or a value) computed from the request, OR
 *   - a QUEUE of responses consumed FIFO (each call shifts the next; throws when exhausted).
 *
 * Every call is RECORDED (`client.calls`) so tests can assert on what the pipeline sent
 * (model, messages, the `format` JSON-schema, …).
 */

import { AgentError } from '../errors'
import type {
  OllamaChatRequest,
  OllamaChatResponse,
  OllamaClient,
  OllamaEmbedRequest,
  OllamaEmbedResponse,
  OllamaMessage,
  OllamaModelInfo,
} from './types'

/** What a chat handler/queue entry may return: a full response, just a message, or a string. */
export type ChatScriptValue = OllamaChatResponse | OllamaMessage | string

/** What an embed handler/queue entry may return: a full response or just the vectors. */
export type EmbedScriptValue = OllamaEmbedResponse | number[][]

export type ChatHandler = (req: OllamaChatRequest) => ChatScriptValue | Promise<ChatScriptValue>
export type EmbedHandler = (req: OllamaEmbedRequest) => EmbedScriptValue | Promise<EmbedScriptValue>

/** The script object passed to {@link createScriptedOllamaClient}. */
export interface OllamaScript {
  /** A handler computing the chat response from the request. */
  chat?: ChatHandler
  /** OR a queue of chat responses consumed FIFO (one per `chat` call). */
  chatQueue?: ChatScriptValue[]
  /** A handler computing the embed response from the request. */
  embed?: EmbedHandler
  /** OR a queue of embed responses consumed FIFO (one per `embed` call). */
  embedQueue?: EmbedScriptValue[]
  /** Models reported by `listModels()` (defaults to `[]`). */
  models?: OllamaModelInfo[]
  /** Response for `show()` (defaults to `{}`). */
  showInfo?: Record<string, unknown>
}

/** A single recorded interaction. */
export type RecordedCall =
  | { kind: 'chat'; req: OllamaChatRequest }
  | { kind: 'embed'; req: OllamaEmbedRequest }
  | { kind: 'pull'; model: string }
  | { kind: 'listModels' }
  | { kind: 'show'; model: string }

/** The scripted client plus its recording surface and the consumed queues. */
export interface ScriptedOllamaClient extends OllamaClient {
  /** Every call made, in order — assert on these in tests. */
  readonly calls: RecordedCall[]
  /** Convenience: just the chat requests, in order. */
  readonly chatCalls: OllamaChatRequest[]
  /** Convenience: just the embed requests, in order. */
  readonly embedCalls: OllamaEmbedRequest[]
}

/** Coerce a {@link ChatScriptValue} into a full {@link OllamaChatResponse}. */
function toChatResponse(value: ChatScriptValue): OllamaChatResponse {
  if (typeof value === 'string') {
    const message: OllamaMessage = { role: 'assistant', content: value }
    return { message, raw: { message } }
  }
  if ('message' in value && 'raw' in value) return value
  // It is a bare OllamaMessage.
  const message = value as OllamaMessage
  return { message, raw: { message } }
}

/** Coerce an {@link EmbedScriptValue} into a full {@link OllamaEmbedResponse}. */
function toEmbedResponse(value: EmbedScriptValue): OllamaEmbedResponse {
  if (Array.isArray(value)) return { embeddings: value, raw: { embeddings: value } }
  return value
}

/**
 * Create a scripted fake Ollama client. Exported from the package barrel so Task 4 can run the
 * server integration test against it (no live model).
 */
export function createScriptedOllamaClient(script: OllamaScript = {}): ScriptedOllamaClient {
  const calls: RecordedCall[] = []
  const chatCalls: OllamaChatRequest[] = []
  const embedCalls: OllamaEmbedRequest[] = []
  // Copy the queues so the caller's arrays are not mutated.
  const chatQueue = script.chatQueue ? [...script.chatQueue] : undefined
  const embedQueue = script.embedQueue ? [...script.embedQueue] : undefined

  return {
    calls,
    chatCalls,
    embedCalls,

    async chat(req: OllamaChatRequest): Promise<OllamaChatResponse> {
      calls.push({ kind: 'chat', req })
      chatCalls.push(req)
      if (script.chat) return toChatResponse(await script.chat(req))
      if (chatQueue) {
        const next = chatQueue.shift()
        if (next === undefined) {
          throw new AgentError('OLLAMA_PARSE', 'scripted chat queue exhausted')
        }
        return toChatResponse(next)
      }
      throw new AgentError('OLLAMA_PARSE', 'scripted client has no chat handler or queue')
    },

    async embed(req: OllamaEmbedRequest): Promise<OllamaEmbedResponse> {
      calls.push({ kind: 'embed', req })
      embedCalls.push(req)
      if (script.embed) return toEmbedResponse(await script.embed(req))
      if (embedQueue) {
        const next = embedQueue.shift()
        if (next === undefined) {
          throw new AgentError('OLLAMA_PARSE', 'scripted embed queue exhausted')
        }
        return toEmbedResponse(next)
      }
      throw new AgentError('OLLAMA_PARSE', 'scripted client has no embed handler or queue')
    },

    async pull(model: string): Promise<void> {
      calls.push({ kind: 'pull', model })
    },

    async listModels(): Promise<OllamaModelInfo[]> {
      calls.push({ kind: 'listModels' })
      return script.models ?? []
    },

    async show(model: string): Promise<Record<string, unknown>> {
      calls.push({ kind: 'show', model })
      return script.showInfo ?? {}
    },
  }
}
