/**
 * A scripted {@link LlmClient} for tests: answer each chat call from a handler computed from the
 * request, or from a FIFO queue of canned responses. Every request is recorded.
 */

import { EngineError } from '../errors'
import type { LlmChatRequest, LlmChatResponse, LlmClient, LlmMessage } from './types'

/** What a handler/queue entry may return: a full response, just a message, or a string. */
export type ChatScriptValue = LlmChatResponse | LlmMessage | string

export type ChatHandler = (req: LlmChatRequest) => ChatScriptValue | Promise<ChatScriptValue>

export interface LlmScript {
  /** A handler computing the response from the request. */
  chat?: ChatHandler
  /** OR a queue of responses consumed FIFO (one per call). */
  chatQueue?: ChatScriptValue[]
}

export interface ScriptedLlmClient extends LlmClient {
  /** Every chat request, in order. */
  readonly chatCalls: LlmChatRequest[]
}

function toChatResponse(value: ChatScriptValue): LlmChatResponse {
  if (typeof value === 'string') {
    const message: LlmMessage = { role: 'assistant', content: value }
    return { message, raw: { message } }
  }
  if ('message' in value) return value
  return { message: value, raw: { message: value } }
}

export function createScriptedLlmClient(script: LlmScript = {}): ScriptedLlmClient {
  const chatCalls: LlmChatRequest[] = []
  const chatQueue = script.chatQueue ? [...script.chatQueue] : undefined

  return {
    chatCalls,
    async chat(req: LlmChatRequest): Promise<LlmChatResponse> {
      chatCalls.push(req)
      if (script.chat) return toChatResponse(await script.chat(req))
      if (chatQueue) {
        const next = chatQueue.shift()
        if (next === undefined) throw new EngineError('LLM_HTTP', 'scripted chat queue exhausted')
        return toChatResponse(next)
      }
      throw new EngineError('LLM_HTTP', 'scripted client has no chat handler or queue')
    },
  }
}
