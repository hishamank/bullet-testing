import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test'
import { createApp } from './app'
import { addDevice } from './auth/devices'
import { openDb } from './db/client'
import { createMemoryAudioStore } from './storage/audio-store'
import { findWebRoot, WEB_CSP } from './web'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'bullet-web-'))
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Bullet</title>')
  writeFileSync(join(dir, 'assets', 'index-abc.js'), 'console.log(1)')
  writeFileSync(join(dir, 'assets', 'sql-wasm-abc.wasm'), new Uint8Array([0, 97, 115, 109]))
  writeFileSync(join(dir, 'assets', 'index-abc.css'), 'body{}')
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

function setup(webRoot: string | undefined) {
  const { db } = openDb(':memory:')
  const device = addDevice(db, 'test browser', 1_000)
  const app = createApp({ db, now: () => 1_000, audioStore: createMemoryAudioStore(), webRoot })
  return { app, token: device.token }
}

describe('serving the built web app', () => {
  test('the page and its files are served without a token, with the right types', async () => {
    const { app } = setup(dir)
    const page = await app.request('/')
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(await page.text()).toContain('<title>Bullet</title>')
    expect((await app.request('/index.html')).status).toBe(200)

    const wasm = await app.request('/assets/sql-wasm-abc.wasm')
    expect(wasm.status).toBe(200)
    expect(wasm.headers.get('content-type')).toBe('application/wasm')
    expect(Array.from(new Uint8Array(await wasm.arrayBuffer()))).toEqual([0, 97, 115, 109])

    expect((await app.request('/assets/index-abc.js')).headers.get('content-type')).toContain(
      'javascript',
    )
    expect((await app.request('/assets/index-abc.css')).headers.get('content-type')).toContain(
      'text/css',
    )
  })

  test('it makes no third-party request possible, and caches by content', async () => {
    const { app } = setup(dir)
    const page = await app.request('/')
    expect(page.headers.get('content-security-policy')).toBe(WEB_CSP)
    expect(WEB_CSP).toContain("default-src 'self'")
    expect(WEB_CSP).toContain("connect-src 'self'")
    expect(WEB_CSP).not.toMatch(/https?:|\*/)
    expect(page.headers.get('x-content-type-options')).toBe('nosniff')
    expect(page.headers.get('referrer-policy')).toBe('no-referrer')
    expect(page.headers.get('cache-control')).toBe('no-cache')
    const asset = await app.request('/assets/index-abc.js')
    expect(asset.headers.get('cache-control')).toContain('immutable')
  })

  test('the sync API is untouched: every route still needs a device token', async () => {
    const { app, token } = setup(dir)
    for (const path of ['/health', '/sync/pull', '/nope', '/assets/missing.js']) {
      const res = await app.request(path)
      expect(res.status, path).toBe(401)
    }
    const ok = await app.request('/health', { headers: { authorization: `Bearer ${token}` } })
    expect(ok.status).toBe(200)
    const push = await app.request('/sync/push', { method: 'POST', body: '{}' })
    expect(push.status).toBe(401)
  })

  test('files outside the build are not reachable', async () => {
    const { app } = setup(dir)
    for (const path of ['/../package.json', '/%2e%2e/package.json', '/assets/../../x']) {
      const res = await app.request(path)
      expect(res.status, path).toBe(401)
    }
  })

  test('without a web build the server is API-only, as before', async () => {
    const { app } = setup(undefined)
    expect((await app.request('/')).status).toBe(401)
  })

  test('the web build is found only where index.html is', () => {
    expect(findWebRoot(dir)).toBe(dir)
    expect(findWebRoot(join(dir, 'assets'))).toBeNull()
    expect(findWebRoot(join(dir, 'missing'))).toBeNull()
  })
})
