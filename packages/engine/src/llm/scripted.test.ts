import { describe, expect, test } from 'vite-plus/test'
import { createScriptedLlmClient } from './scripted'

describe('createScriptedLlmClient', () => {
  test('returns canned chat responses from a handler and records the calls', async () => {
    const client = createScriptedLlmClient({
      chat: (req) => `echo:${req.messages[0]?.content ?? ''}`,
    })
    const res = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
    expect(res.message.content).toBe('echo:hi')
    expect(client.chatCalls).toHaveLength(1)
  })

  test('consumes a chat queue FIFO and throws when exhausted', async () => {
    const client = createScriptedLlmClient({ chatQueue: ['a', 'b'] })
    expect((await client.chat({ model: 'm', messages: [] })).message.content).toBe('a')
    expect((await client.chat({ model: 'm', messages: [] })).message.content).toBe('b')
    await expect(client.chat({ model: 'm', messages: [] })).rejects.toMatchObject({
      code: 'LLM_HTTP',
    })
  })
})
