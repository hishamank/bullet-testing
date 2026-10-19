import { describe, expect, test, vi } from 'vite-plus/test'
import { createOpenAiCompatibleClient } from './openai-compatible'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('createOpenAiCompatibleClient', () => {
  test('posts to /v1/chat/completions with a json_schema response_format', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { role: 'assistant', content: '{"ok":true}' } }] }),
    )
    const client = createOpenAiCompatibleClient({
      baseUrl: 'http://home.local:8080/',
      apiKey: 'test-key',
      fetch: fetchMock as unknown as typeof fetch,
    })
    const schema = { type: 'object' }
    const res = await client.chat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      jsonSchema: schema,
      maxTokens: 512,
    })

    expect(res.message.content).toBe('{"ok":true}')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://home.local:8080/v1/chat/completions')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-key')
    const sent = JSON.parse(init.body as string)
    expect(sent.max_tokens).toBe(512)
    expect(sent.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'response', strict: true, schema },
    })
  })

  test('maps a non-OK status to LLM_HTTP', async () => {
    const client = createOpenAiCompatibleClient({
      baseUrl: 'http://x',
      fetch: (async () => new Response('down', { status: 503 })) as typeof fetch,
    })
    await expect(client.chat({ model: 'm', messages: [] })).rejects.toMatchObject({
      code: 'LLM_HTTP',
    })
  })

  test('maps a network failure to LLM_HTTP', async () => {
    const client = createOpenAiCompatibleClient({
      baseUrl: 'http://x',
      fetch: (async () => {
        throw new TypeError('fetch failed')
      }) as typeof fetch,
    })
    await expect(client.chat({ model: 'm', messages: [] })).rejects.toMatchObject({
      code: 'LLM_HTTP',
    })
  })

  test('maps a response without content to LLM_PARSE', async () => {
    const client = createOpenAiCompatibleClient({
      baseUrl: 'http://x',
      fetch: (async () => jsonResponse({ choices: [] })) as typeof fetch,
    })
    await expect(client.chat({ model: 'm', messages: [] })).rejects.toMatchObject({
      code: 'LLM_PARSE',
    })
  })
})
