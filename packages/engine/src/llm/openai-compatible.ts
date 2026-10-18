/**
 * An {@link LlmClient} over an OpenAI-compatible `/v1/chat/completions` endpoint — the API
 * llama.cpp's `llama-server` exposes. Plain `fetch`, no SDK, so it runs anywhere.
 *
 * Structured output is sent as `response_format: { type: 'json_schema', json_schema: … }`,
 * which llama-server compiles into a grammar that constrains decoding.
 */

import { EngineError } from '../errors'
import type { LlmChatRequest, LlmChatResponse, LlmClient } from './types'

export interface OpenAiCompatibleOptions {
  /** Server root, e.g. `http://127.0.0.1:8080` (the `/v1/...` path is appended). */
  baseUrl: string
  /** Optional bearer token (llama-server `--api-key`). */
  apiKey?: string
  /** Abort a request after this many ms. Default 120 000. */
  timeoutMs?: number
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch
}

interface ChatCompletionBody {
  choices?: { message?: { role?: string; content?: string | null } }[]
}

export function createOpenAiCompatibleClient(opts: OpenAiCompatibleOptions): LlmClient {
  const doFetch = opts.fetch ?? fetch
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`
  const timeoutMs = opts.timeoutMs ?? 120_000

  return {
    async chat(req: LlmChatRequest): Promise<LlmChatResponse> {
      const body: Record<string, unknown> = { model: req.model, messages: req.messages }
      if (req.temperature !== undefined) body.temperature = req.temperature
      if (req.seed !== undefined) body.seed = req.seed
      if (req.jsonSchema) {
        body.response_format = {
          type: 'json_schema',
          json_schema: { name: 'response', strict: true, schema: req.jsonSchema },
        }
      }

      let res: Response
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (err) {
        throw new EngineError('LLM_HTTP', `LLM request failed: ${String(err)}`, err)
      }
      if (!res.ok) {
        throw new EngineError('LLM_HTTP', `LLM server responded ${res.status}`, await res.text())
      }

      const raw = (await res.json()) as ChatCompletionBody & Record<string, unknown>
      const content = raw.choices?.[0]?.message?.content
      if (typeof content !== 'string') {
        throw new EngineError('LLM_PARSE', 'LLM response had no message content', raw)
      }
      return { message: { role: 'assistant', content }, raw }
    },
  }
}
