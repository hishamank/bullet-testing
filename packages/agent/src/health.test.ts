import { describe, expect, test } from 'vitest'
import { AGENT_CONFIG_DEFAULTS } from './config'
import { checkOllamaHealth } from './health'
import { createScriptedOllamaClient } from './ollama/scripted'

const config = { ...AGENT_CONFIG_DEFAULTS, liveModel: 'gemma3:4b' }

describe('checkOllamaHealth', () => {
  test('reachable with the live model present', async () => {
    const ollama = createScriptedOllamaClient({
      models: [{ name: 'gemma3:4b' }, { name: 'llama3' }],
    })
    const health = await checkOllamaHealth({ ollama, config })
    expect(health).toEqual({
      reachable: true,
      models: ['gemma3:4b', 'llama3'],
      liveModelAvailable: true,
      liveModel: 'gemma3:4b',
    })
  })

  test('reachable but the live model is absent', async () => {
    const ollama = createScriptedOllamaClient({ models: [{ name: 'llama3' }] })
    const health = await checkOllamaHealth({ ollama, config })
    expect(health.reachable).toBe(true)
    expect(health.liveModelAvailable).toBe(false)
    expect(health.models).toEqual(['llama3'])
    expect(health.error).toBeUndefined()
  })

  test('a tagless configured model matches the listed `:latest` tag', async () => {
    // OLLAMA_LIVE_MODEL=gemma3 (tagless) should count `gemma3:latest` (as Ollama lists it) available.
    const taglessConfig = { ...AGENT_CONFIG_DEFAULTS, liveModel: 'gemma3' }
    const ollama = createScriptedOllamaClient({ models: [{ name: 'gemma3:latest' }] })
    const health = await checkOllamaHealth({ ollama, config: taglessConfig })
    expect(health.reachable).toBe(true)
    expect(health.liveModelAvailable).toBe(true)
  })

  test('unreachable when listModels throws (server down → "fetch failed")', async () => {
    const ollama = createScriptedOllamaClient()
    // Simulate the real failure: HttpOllamaClient throws when Ollama isn't running.
    ollama.listModels = async () => {
      throw new Error('fetch failed')
    }
    const health = await checkOllamaHealth({ ollama, config })
    expect(health.reachable).toBe(false)
    expect(health.liveModelAvailable).toBe(false)
    expect(health.models).toEqual([])
    expect(health.liveModel).toBe('gemma3:4b')
    expect(health.error).toBe('fetch failed')
  })
})
