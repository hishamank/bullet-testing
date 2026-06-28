import { afterEach, describe, expect, test, vi } from 'vitest'
import { AgentError } from '../errors'
import { HttpOllamaClient } from './http'

/** Build a `fetch` stub returning a JSON body, recording the calls it receives. */
function jsonFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const ok = init.ok ?? true
  const status = init.status ?? (ok ? 200 : 500)
  return vi.fn(async (_url: string, _opts?: RequestInit) => ({
    ok,
    status,
    statusText: ok ? 'OK' : 'Internal Server Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  }))
}

/** The first recorded call's `[url, opts]`, asserting one was made. */
function firstCall(spy: ReturnType<typeof jsonFetch>): { url: string; opts: RequestInit } {
  const call = spy.mock.calls[0]
  if (!call) throw new Error('fetch was not called')
  return { url: call[0] as unknown as string, opts: (call[1] ?? {}) as RequestInit }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HttpOllamaClient.chat', () => {
  test('POSTs /api/chat with model, messages and the format JSON-schema (structured output)', async () => {
    const fetchSpy = jsonFetch({ message: { role: 'assistant', content: '{"candidates":[]}' } })
    vi.stubGlobal('fetch', fetchSpy)

    const client = new HttpOllamaClient({ baseUrl: 'http://ollama.test:11434/' })
    const schema = { type: 'object', properties: { candidates: { type: 'array' } } }
    const res = await client.chat({
      model: 'gemma3:4b',
      messages: [{ role: 'user', content: 'hi' }],
      format: schema,
    })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const { url, opts } = firstCall(fetchSpy)
    // Trailing slash on baseUrl is trimmed.
    expect(url).toBe('http://ollama.test:11434/api/chat')
    expect(opts.method).toBe('POST')
    const sent = JSON.parse(opts.body as string)
    expect(sent.model).toBe('gemma3:4b')
    expect(sent.messages).toEqual([{ role: 'user', content: 'hi' }])
    // The format JSON-schema is passed through to enable structured output.
    expect(sent.format).toEqual(schema)
    expect(sent.stream).toBe(false)

    // The assistant message is parsed back out.
    expect(res.message.content).toBe('{"candidates":[]}')
    expect(res.raw).toBeTypeOf('object')
  })

  test('throws OLLAMA_PARSE when the response has no message.content', async () => {
    vi.stubGlobal('fetch', jsonFetch({ nope: true }))
    const client = new HttpOllamaClient({ baseUrl: 'http://x' })
    await expect(client.chat({ model: 'm', messages: [] })).rejects.toMatchObject({
      name: 'AgentError',
      code: 'OLLAMA_PARSE',
    })
  })

  test('throws a typed OLLAMA_HTTP error on a non-OK response', async () => {
    vi.stubGlobal('fetch', jsonFetch({ error: 'boom' }, { ok: false, status: 500 }))
    const client = new HttpOllamaClient({ baseUrl: 'http://x' })
    const err = await client.chat({ model: 'm', messages: [] }).catch((e) => e)
    expect(err).toBeInstanceOf(AgentError)
    expect(err.code).toBe('OLLAMA_HTTP')
    expect(err.message).toContain('500')
  })
})

describe('HttpOllamaClient.embed', () => {
  test('POSTs /api/embed and returns the embeddings vectors', async () => {
    const fetchSpy = jsonFetch({ embeddings: [[0.1, 0.2, 0.3]] })
    vi.stubGlobal('fetch', fetchSpy)
    const client = new HttpOllamaClient({ baseUrl: 'http://x' })
    const res = await client.embed({ model: 'embed-model', input: 'hello' })
    const { url, opts } = firstCall(fetchSpy)
    expect(url).toBe('http://x/api/embed')
    expect(JSON.parse(opts.body as string)).toEqual({ model: 'embed-model', input: 'hello' })
    expect(res.embeddings).toEqual([[0.1, 0.2, 0.3]])
  })

  test('throws OLLAMA_PARSE when embeddings are missing', async () => {
    vi.stubGlobal('fetch', jsonFetch({}))
    const client = new HttpOllamaClient({ baseUrl: 'http://x' })
    await expect(client.embed({ model: 'm', input: 'x' })).rejects.toMatchObject({
      code: 'OLLAMA_PARSE',
    })
  })
})

describe('HttpOllamaClient.pull / listModels / show', () => {
  test('pull POSTs /api/pull with the model and stream:false', async () => {
    const fetchSpy = jsonFetch({ status: 'success' })
    vi.stubGlobal('fetch', fetchSpy)
    const client = new HttpOllamaClient({ baseUrl: 'http://x' })
    await client.pull('gemma3:4b')
    const { url, opts } = firstCall(fetchSpy)
    expect(url).toBe('http://x/api/pull')
    expect(JSON.parse(opts.body as string)).toEqual({ model: 'gemma3:4b', stream: false })
  })

  test('listModels GETs /api/tags and returns the models array', async () => {
    const fetchSpy = jsonFetch({ models: [{ name: 'gemma3:4b' }, { name: 'llama3' }] })
    vi.stubGlobal('fetch', fetchSpy)
    const client = new HttpOllamaClient({ baseUrl: 'http://x' })
    const models = await client.listModels()
    const { url, opts } = firstCall(fetchSpy)
    expect(url).toBe('http://x/api/tags')
    expect(opts.method).toBe('GET')
    expect(models.map((m) => m.name)).toEqual(['gemma3:4b', 'llama3'])
  })

  test('listModels returns [] when the body has no models', async () => {
    vi.stubGlobal('fetch', jsonFetch({}))
    const client = new HttpOllamaClient({ baseUrl: 'http://x' })
    expect(await client.listModels()).toEqual([])
  })

  test('show POSTs /api/show and returns the body', async () => {
    vi.stubGlobal('fetch', jsonFetch({ details: { family: 'gemma' } }))
    const client = new HttpOllamaClient({ baseUrl: 'http://x' })
    const info = await client.show('gemma3:4b')
    expect(info).toEqual({ details: { family: 'gemma' } })
  })

  test('a non-OK status on a GET endpoint throws OLLAMA_HTTP', async () => {
    vi.stubGlobal('fetch', jsonFetch('nope', { ok: false, status: 404 }))
    const client = new HttpOllamaClient({ baseUrl: 'http://x' })
    await expect(client.listModels()).rejects.toMatchObject({ code: 'OLLAMA_HTTP' })
  })
})
