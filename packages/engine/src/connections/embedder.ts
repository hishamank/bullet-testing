/**
 * Embeddings for connections (slice 3). The engine depends on the {@link Embedder} interface; the
 * server injects {@link createOpenAiCompatibleEmbedder} (llama-server's `/v1/embeddings`, started
 * with `--embeddings`), tests inject {@link createScriptedEmbedder}. Nothing is downloaded and no
 * hosted service is used.
 */

import { EngineError } from '../errors'

export interface Embedder {
  /**
   * The vector space: the model plus the text template. Vectors stored under another key are
   * stale and get embedded again.
   */
  readonly key: string
  /** One vector per text, in order. */
  embed(texts: string[]): Promise<number[][]>
}

/**
 * Wraps each text before it is embedded, `{text}` standing for it. A general LLM used as an
 * embedder (Qwen3.5-4B) separates topics far better when asked what a note is about in one word
 * (the "PromptEOL" trick); a dedicated embedding model needs no template, or its own task prefix.
 */
export interface EmbedTemplate {
  /** Short stable id, part of the embedder key (change it when the wording changes). */
  id: string
  text: string
}

/** The template calibrated for a general LLM used as an embedder (docs/home-server.md). */
export const JOURNAL_NOTE_TEMPLATE: EmbedTemplate = {
  id: 'journal-eol-v1',
  text: 'This journal note : "{text}" is about, in one word:"',
}

export function applyTemplate(template: EmbedTemplate | null, text: string): string {
  return template ? template.text.replace('{text}', text) : text
}

export function embedderKey(model: string, template: EmbedTemplate | null): string {
  return template ? `${model}|${template.id}` : model
}

export interface OpenAiCompatibleEmbedderOptions {
  /** Server root, e.g. `http://127.0.0.1:8082` (`/v1/embeddings` is appended). */
  baseUrl: string
  /** Label sent as `model` and stored with every vector. */
  model: string
  apiKey?: string
  template?: EmbedTemplate | null
  /** Abort a request after this many ms. Default 60 000. */
  timeoutMs?: number
  /** Texts per request. Default 16. */
  batchSize?: number
  fetch?: typeof fetch
}

interface EmbeddingsBody {
  data?: { embedding?: unknown; index?: number }[]
}

export function createOpenAiCompatibleEmbedder(opts: OpenAiCompatibleEmbedderOptions): Embedder {
  const doFetch = opts.fetch ?? fetch
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/v1/embeddings`
  const timeoutMs = opts.timeoutMs ?? 60_000
  const batchSize = Math.max(1, opts.batchSize ?? 16)
  const template = opts.template ?? null

  async function embedBatch(texts: string[]): Promise<number[][]> {
    let res: Response
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: opts.model,
          input: texts.map((t) => applyTemplate(template, t)),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new EngineError('EMBED_TIMEOUT', `embeddings did not answer within ${timeoutMs}ms`)
      }
      throw new EngineError('EMBED_HTTP', `embeddings request failed: ${String(err)}`, err)
    }
    if (!res.ok) {
      throw new EngineError('EMBED_HTTP', `embeddings server responded ${res.status}`, {
        body: await res.text(),
      })
    }
    const body = (await res.json()) as EmbeddingsBody
    const data = body.data ?? []
    if (data.length !== texts.length) {
      throw new EngineError('EMBED_HTTP', `expected ${texts.length} embeddings, got ${data.length}`)
    }
    const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    return ordered.map((d) => {
      const v = d.embedding
      // llama-server returns a nested array for pooling `none`; we need one vector per text.
      if (!Array.isArray(v) || v.length === 0 || typeof v[0] !== 'number') {
        throw new EngineError('EMBED_HTTP', 'an embedding was not a flat vector (set --pooling)')
      }
      return v as number[]
    })
  }

  return {
    key: embedderKey(opts.model, template),
    async embed(texts) {
      const out: number[][] = []
      for (let i = 0; i < texts.length; i += batchSize) {
        out.push(...(await embedBatch(texts.slice(i, i + batchSize))))
      }
      return out
    },
  }
}

export interface ScriptedEmbedder extends Embedder {
  /** Every text embedded, in order. */
  readonly calls: string[][]
}

/** An embedder for tests: vectors computed from the text by `fn`. */
export function createScriptedEmbedder(
  fn: (text: string) => number[] | Promise<number[]>,
  key = 'scripted',
): ScriptedEmbedder {
  const calls: string[][] = []
  return {
    key,
    calls,
    async embed(texts) {
      calls.push([...texts])
      return Promise.all(texts.map(async (t) => fn(t)))
    },
  }
}

/** A deadline for any embedder, like `withLlmTimeout`. */
export function withEmbedTimeout(embedder: Embedder, timeoutMs: number): Embedder {
  return {
    key: embedder.key,
    embed(texts) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(new EngineError('EMBED_TIMEOUT', `embeddings took longer than ${timeoutMs}ms`)),
          timeoutMs,
        )
        embedder.embed(texts).then(
          (v) => {
            clearTimeout(timer)
            resolve(v)
          },
          (err: unknown) => {
            clearTimeout(timer)
            reject(err instanceof Error ? err : new Error(String(err)))
          },
        )
      })
    },
  }
}
