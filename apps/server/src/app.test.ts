import { pullResponseSchema, pushResponseSchema } from '@bullet/core'
import { describe, expect, test } from 'vite-plus/test'
import { addDevice, hashToken, revokeDevice } from './auth/devices'
import { loadServerConfig } from './config'
import { devices } from './db/schema'
import { createHarness, uid } from './test/helpers'

describe('auth', () => {
  test('every route requires a device token, /health included', async () => {
    const h = createHarness()
    for (const path of ['/health', '/sync/pull', '/nope']) {
      const res = await h.request(path)
      expect(res.status, path).toBe(401)
      expect(await res.json()).toEqual({
        error: { code: 'unauthorized', message: 'missing or invalid device token' },
      })
    }
    const bad = await h.request('/health', { headers: { authorization: 'Bearer bjd_wrong' } })
    expect(bad.status).toBe(401)
  })

  test('a valid token works; a revoked one does not', async () => {
    const h = createHarness()
    const ok = await h.request('/health', { headers: { authorization: `Bearer ${h.token}` } })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true })

    const [device] = h.db.select().from(devices).all()
    revokeDevice(h.db, device?.id ?? '', h.clock.now)
    const res = await h.request('/health', { headers: { authorization: `Bearer ${h.token}` } })
    expect(res.status).toBe(401)
  })

  test('tokens are stored hashed, never in plaintext', () => {
    const h = createHarness()
    const rows = h.db.select().from(devices).all()
    expect(rows[0]?.token_hash).toBe(hashToken(h.token))
    expect(JSON.stringify(rows)).not.toContain(h.token)
  })

  test("a second device of the same owner sees the owner's data", async () => {
    const h = createHarness()
    await h.capture('hello')
    const other = addDevice(h.db, 'ipad', h.clock.now, h.ownerId)
    const res = await h.request('/sync/pull', {
      headers: { authorization: `Bearer ${other.token}` },
    })
    const body = pullResponseSchema.parse(await res.json())
    expect(body.changes.bullets).toHaveLength(1)
  })
})

describe('request validation', () => {
  test('a malformed push is a 400 with the error envelope', async () => {
    const h = createHarness()
    const res = await h.request('/sync/push', {
      method: 'POST',
      headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ops: [{ op_id: uid(), type: 'bullet.create' }] }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('bad_request')
  })

  test('a bad cursor is a 400', async () => {
    const h = createHarness()
    const res = await h.request('/sync/pull?cursor=abc', {
      headers: { authorization: `Bearer ${h.token}` },
    })
    expect(res.status).toBe(400)
  })

  test('responses match the contract schemas', async () => {
    const h = createHarness()
    const push = await h.push([
      {
        op_id: uid(),
        type: 'bullet.create',
        bullet: { id: uid(), text: 'x', captured_at: 1, timezone: 'UTC', source: 'voice' },
      },
    ])
    expect(pushResponseSchema.safeParse(push).success).toBe(true)
    expect(pullResponseSchema.safeParse(await h.pull()).success).toBe(true)
  })
})

test('config binds to loopback by default', () => {
  expect(loadServerConfig({}).host).toBe('127.0.0.1')
})

test('config leaves the transcriber off unless WHISPER_BASE_URL is set', () => {
  expect(loadServerConfig({}).whisperBaseUrl).toBeUndefined()
  const c = loadServerConfig({ WHISPER_BASE_URL: 'http://127.0.0.1:8081', WHISPER_MODEL: 'x' })
  expect(c.whisperBaseUrl).toBe('http://127.0.0.1:8081')
  expect(c.whisperModel).toBe('x')
})
