import { ENGINE_CONFIG_DEFAULTS } from '@bullet/engine'
import { describe, expect, test } from 'vite-plus/test'
import { engineConfig, envFlag, loadServerConfig } from './config'

describe('server config', () => {
  test('AUTO_APPLY_VALUE_RECORDS is off unless set to a true value', () => {
    expect(loadServerConfig({}).autoApplyValueRecords).toBe(false)
    expect(loadServerConfig({ AUTO_APPLY_VALUE_RECORDS: 'false' }).autoApplyValueRecords).toBe(
      false,
    )
    expect(loadServerConfig({ AUTO_APPLY_VALUE_RECORDS: ' TRUE ' }).autoApplyValueRecords).toBe(
      true,
    )
    for (const v of ['1', 'yes', 'on']) expect(envFlag(v), v).toBe(true)
    for (const v of ['0', 'no', '', 'maybe', undefined]) expect(envFlag(v), String(v)).toBe(false)
  })

  test("it reaches the engine's autoApplyValueRecords; the rest stays at the defaults", () => {
    const off = engineConfig(loadServerConfig({ LLM_MODEL: 'qwen' }))
    expect(off).toEqual({ ...ENGINE_CONFIG_DEFAULTS, model: 'qwen', autoApplyValueRecords: false })
    const on = engineConfig(loadServerConfig({ AUTO_APPLY_VALUE_RECORDS: 'true' }))
    expect(on.autoApplyValueRecords).toBe(true)
  })

  test('embeddings: a chat server fallback reads as an LLM; a named server by its model', () => {
    // No EMBED_BASE_URL: embeddings come from the chat model's own server.
    expect(loadServerConfig({ EMBED_MODEL: 'nomic-embed-text' }).embedProfile.name).toBe('llm')
    expect(loadServerConfig({}).embedProfile.name).toBe('llm')
    const own = { EMBED_BASE_URL: 'http://127.0.0.1:8082' }
    expect(loadServerConfig({ ...own, EMBED_MODEL: 'nomic-embed-text' }).embedProfile.name).toBe(
      'dedicated',
    )
    expect(loadServerConfig({ ...own, EMBED_MODEL: 'qwen3.5-4b' }).embedProfile.name).toBe('llm')
    // EMBED_PROFILE always wins; thresholds can be overridden one by one.
    const c = loadServerConfig({ EMBED_PROFILE: 'dedicated', LINK_THRESHOLD: '0.85' })
    expect(c.embedProfile.name).toBe('dedicated')
    expect(c.embedProfile.thresholds.link).toBe(0.85)
    expect(c.embedProfile.thresholds.linkSharedEntity).toBe(0.75)
  })
})
