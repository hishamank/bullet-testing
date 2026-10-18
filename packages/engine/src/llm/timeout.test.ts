import { expect, test } from 'vite-plus/test'
import { createScriptedLlmClient } from './scripted'
import { withLlmTimeout } from './timeout'

const req = { model: 'm', messages: [] }

test('passes a fast answer through', async () => {
  const llm = withLlmTimeout(createScriptedLlmClient({ chat: () => 'ok' }), 1000)
  expect((await llm.chat(req)).message.content).toBe('ok')
})

test('rejects with LLM_TIMEOUT when the model hangs', async () => {
  const hung = { chat: () => new Promise<never>(() => {}) }
  const err = await withLlmTimeout(hung, 10)
    .chat(req)
    .catch((e: unknown) => e)
  expect(err).toMatchObject({ name: 'EngineError', code: 'LLM_TIMEOUT' })
})

test('propagates the inner error unchanged', async () => {
  const llm = withLlmTimeout(createScriptedLlmClient({ chatQueue: [] }), 1000)
  await expect(llm.chat(req)).rejects.toMatchObject({ code: 'LLM_HTTP' })
})
