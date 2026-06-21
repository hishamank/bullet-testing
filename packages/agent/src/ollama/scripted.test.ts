import { describe, expect, test } from 'vitest'
import { createScriptedOllamaClient } from './scripted'

describe('createScriptedOllamaClient', () => {
  test('returns canned chat responses from a handler and records the calls', async () => {
    const client = createScriptedOllamaClient({
      chat: (req) => `echo:${req.messages[0]?.content ?? ''}`,
    })
    const res = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
    expect(res.message.content).toBe('echo:hi')
    expect(client.chatCalls).toHaveLength(1)
    expect(client.calls[0]).toMatchObject({ kind: 'chat' })
  })

  test('consumes a chat queue FIFO and throws when exhausted', async () => {
    const client = createScriptedOllamaClient({ chatQueue: ['a', 'b'] })
    expect((await client.chat({ model: 'm', messages: [] })).message.content).toBe('a')
    expect((await client.chat({ model: 'm', messages: [] })).message.content).toBe('b')
    await expect(client.chat({ model: 'm', messages: [] })).rejects.toMatchObject({
      code: 'OLLAMA_PARSE',
    })
  })

  test('embed returns vectors and records', async () => {
    const client = createScriptedOllamaClient({ embed: () => [[1, 2, 3]] })
    const res = await client.embed({ model: 'm', input: 'x' })
    expect(res.embeddings).toEqual([[1, 2, 3]])
    expect(client.embedCalls).toHaveLength(1)
  })

  test('listModels / show / pull are recorded', async () => {
    const client = createScriptedOllamaClient({ models: [{ name: 'gemma3:4b' }] })
    expect(await client.listModels()).toEqual([{ name: 'gemma3:4b' }])
    await client.pull('gemma3:4b')
    await client.show('gemma3:4b')
    expect(client.calls.map((c) => c.kind)).toContain('pull')
    expect(client.calls.map((c) => c.kind)).toContain('show')
    expect(client.calls.map((c) => c.kind)).toContain('listModels')
  })
})
