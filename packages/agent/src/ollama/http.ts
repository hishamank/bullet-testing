/**
 * HttpOllamaClient — the real {@link OllamaClient}, implemented over `fetch` against an Ollama
 * server. No SDK dependency; we hit the documented HTTP endpoints directly and pass `format`
 * through to enable structured output.
 *
 * In TESTS this is exercised with a stubbed global `fetch` (vi.stubGlobal) — never a live
 * server. CI never requires a running Ollama.
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

export interface HttpOllamaClientOptions {
  /** The Ollama base URL, e.g. `http://localhost:11434`. */
  baseUrl: string
  /** Optional `fetch` override (defaults to the global). Handy for non-test injection. */
  fetch?: typeof fetch
}

export class HttpOllamaClient implements OllamaClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(opts: HttpOllamaClientOptions) {
    // Trim a trailing slash so `${baseUrl}/api/chat` never doubles up.
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    // Bind so a global `fetch` keeps the correct `this`.
    this.fetchImpl = opts.fetch ?? ((...args) => globalThis.fetch(...args))
  }

  /** POST a JSON body to `path`, throwing a typed AgentError on a non-OK response. */
  private async postJson(path: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await safeText(res)
      throw new AgentError(
        'OLLAMA_HTTP',
        `Ollama ${path} responded ${res.status} ${res.statusText}`,
        text,
      )
    }
    return (await res.json()) as Record<string, unknown>
  }

  /** GET JSON from `path`, throwing a typed AgentError on a non-OK response. */
  private async getJson(path: string): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { method: 'GET' })
    if (!res.ok) {
      const text = await safeText(res)
      throw new AgentError(
        'OLLAMA_HTTP',
        `Ollama ${path} responded ${res.status} ${res.statusText}`,
        text,
      )
    }
    return (await res.json()) as Record<string, unknown>
  }

  async chat(req: OllamaChatRequest): Promise<OllamaChatResponse> {
    const raw = await this.postJson('/api/chat', {
      model: req.model,
      messages: req.messages,
      // Pass `format` through to enable Ollama structured output (JSON-schema or 'json').
      ...(req.format !== undefined ? { format: req.format } : {}),
      ...(req.options !== undefined ? { options: req.options } : {}),
      // The agent reads a single complete response, never a token stream.
      stream: false,
    })
    const message = raw.message as OllamaMessage | undefined
    if (!message || typeof message.content !== 'string') {
      throw new AgentError('OLLAMA_PARSE', 'Ollama chat response had no message.content', raw)
    }
    return { message, raw }
  }

  async embed(req: OllamaEmbedRequest): Promise<OllamaEmbedResponse> {
    const raw = await this.postJson('/api/embed', { model: req.model, input: req.input })
    const embeddings = raw.embeddings as number[][] | undefined
    if (!Array.isArray(embeddings)) {
      throw new AgentError('OLLAMA_PARSE', 'Ollama embed response had no embeddings array', raw)
    }
    return { embeddings, raw }
  }

  async pull(model: string): Promise<void> {
    // stream:false makes Ollama block until the pull completes and return a single status body.
    await this.postJson('/api/pull', { model, stream: false })
  }

  async listModels(): Promise<OllamaModelInfo[]> {
    const raw = await this.getJson('/api/tags')
    const models = raw.models as OllamaModelInfo[] | undefined
    return Array.isArray(models) ? models : []
  }

  async show(model: string): Promise<Record<string, unknown>> {
    return this.postJson('/api/show', { model })
  }
}

/** Read a response body as text without throwing (best-effort error detail). */
async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}
