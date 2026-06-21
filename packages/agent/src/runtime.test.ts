import { createBullet, createTestDb, createUser, listSuggestionsByBullet } from '@bullet/db'
import { describe, expect, test } from 'vitest'
import { AGENT_CONFIG_DEFAULTS } from './config'
import type { ExtractionCompleteEvent } from './events'
import { createScriptedOllamaClient } from './ollama/scripted'
import { createAgentRuntime } from './runtime'

describe('createAgentRuntime', () => {
  test('wires the worker + emitter + helpers for an end-to-end run', async () => {
    const { db } = createTestDb()
    const user = createUser(db, { name: 'U' })
    const bullet = createBullet(db, { owner_id: user.id, text: 'ran 5k' })

    const ollama = createScriptedOllamaClient({
      chat: () =>
        JSON.stringify({
          candidates: [
            {
              kind: 'activity',
              orientation: 'happened',
              text: 'ran 5k',
              fields: { name: 'ran 5k' },
              confidence: 0.95,
            },
          ],
        }),
    })

    const runtime = createAgentRuntime({ db, ollama, config: AGENT_CONFIG_DEFAULTS })
    const completed: ExtractionCompleteEvent[] = []
    runtime.emitter.on('extraction:complete', (e) => completed.push(e))

    runtime.enqueueExtraction(bullet.id, user.id)
    const processed = await runtime.worker.drain()

    expect(processed).toBe(1)
    expect(completed).toHaveLength(1)
    expect(listSuggestionsByBullet(db, bullet.id)).toHaveLength(1)
    expect(runtime.deps.config).toBe(AGENT_CONFIG_DEFAULTS)
    expect(runtime.weekly).toBeDefined()
  })
})
