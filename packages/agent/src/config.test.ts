import { describe, expect, test } from 'vitest'
import { AGENT_CONFIG_DEFAULTS, loadAgentConfig } from './config'

describe('loadAgentConfig', () => {
  test('applies sane defaults for an empty environment', () => {
    const config = loadAgentConfig({})
    expect(config).toEqual(AGENT_CONFIG_DEFAULTS)
    expect(config.baseUrl).toBe('http://localhost:11434')
    expect(config.liveModel).toBe('gemma3:4b')
    expect(config.weeklyModel).toBe('gemma3:4b')
    expect(config.autoThreshold).toBe(0.85)
    expect(config.suggestThreshold).toBe(0.5)
    expect(config.autoCreateTasks).toBe(false)
    expect(config.autoApplyValueRecords).toBe(false)
  })

  test('reads overrides from the environment', () => {
    const config = loadAgentConfig({
      OLLAMA_BASE_URL: 'http://gpu-box:11434',
      OLLAMA_LIVE_MODEL: 'qwen2.5:7b',
      OLLAMA_WEEKLY_MODEL: 'llama3.1:8b',
      AGENT_AUTO_THRESHOLD: '0.9',
      AGENT_SUGGEST_THRESHOLD: '0.4',
      AGENT_AUTO_CREATE_TASKS: 'true',
      AGENT_AUTO_APPLY_VALUE_RECORDS: 'true',
    })
    expect(config).toEqual({
      baseUrl: 'http://gpu-box:11434',
      liveModel: 'qwen2.5:7b',
      weeklyModel: 'llama3.1:8b',
      autoThreshold: 0.9,
      suggestThreshold: 0.4,
      autoCreateTasks: true,
      autoApplyValueRecords: true,
    })
  })

  test('falls back to defaults for blank or non-numeric values', () => {
    const config = loadAgentConfig({
      OLLAMA_BASE_URL: '   ',
      AGENT_AUTO_THRESHOLD: 'not-a-number',
    })
    expect(config.baseUrl).toBe(AGENT_CONFIG_DEFAULTS.baseUrl)
    expect(config.autoThreshold).toBe(AGENT_CONFIG_DEFAULTS.autoThreshold)
  })
})
