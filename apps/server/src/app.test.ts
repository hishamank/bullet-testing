import { expect, test } from 'vite-plus/test'
import { createApp } from './app'
import { loadServerConfig } from './config'

test('GET /health responds ok', async () => {
  const res = await createApp().request('/health')
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
})

test('config binds to loopback by default', () => {
  expect(loadServerConfig({}).host).toBe('127.0.0.1')
})
