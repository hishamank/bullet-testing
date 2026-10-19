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
})
