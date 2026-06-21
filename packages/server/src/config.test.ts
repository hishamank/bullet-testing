import { createTestDb } from '@bullet/db'
import { describe, expect, test } from 'vitest'
import { loadServerConfig, SERVER_CONFIG_DEFAULTS } from './config'
import { getOrCreateDefaultOwner } from './owner'

describe('loadServerConfig', () => {
  test('applies defaults when env is empty', () => {
    const config = loadServerConfig({})
    expect(config.port).toBe(SERVER_CONFIG_DEFAULTS.port)
    expect(config.databasePath).toBe(SERVER_CONFIG_DEFAULTS.databasePath)
    expect(config.corsOrigin).toBe(SERVER_CONFIG_DEFAULTS.corsOrigin)
    // The embedded agent config is present.
    expect(config.agent.baseUrl).toBeTruthy()
  })

  test('reads PORT / DATABASE_PATH / CORS_ORIGIN from env', () => {
    const config = loadServerConfig({
      PORT: '4000',
      DATABASE_PATH: '/tmp/bullet.db',
      CORS_ORIGIN: 'http://localhost:5173',
      OLLAMA_BASE_URL: 'http://ollama:11434',
    })
    expect(config.port).toBe(4000)
    expect(config.databasePath).toBe('/tmp/bullet.db')
    expect(config.corsOrigin).toBe('http://localhost:5173')
    expect(config.agent.baseUrl).toBe('http://ollama:11434')
  })

  test('falls back to the default PORT on a non-numeric value', () => {
    expect(loadServerConfig({ PORT: 'nope' }).port).toBe(SERVER_CONFIG_DEFAULTS.port)
  })
})

describe('getOrCreateDefaultOwner', () => {
  test('creates the single owner once and returns the same id thereafter', () => {
    const { db } = createTestDb()
    const first = getOrCreateDefaultOwner(db)
    const second = getOrCreateDefaultOwner(db)
    expect(first).toBe(second)
  })
})
