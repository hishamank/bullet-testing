import { createBullet } from '@bullet/db'
import { describe, expect, test } from 'vitest'
import { createApp } from './app'
import { activityPlusTaskScript, buildTestDeps } from './test-helpers'

describe('createApp — HTTP surface (in-process, no socket)', () => {
  test('GET /health responds ok', async () => {
    const app = createApp(buildTestDeps())
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; now: number }
    expect(body.ok).toBe(true)
    expect(typeof body.now).toBe('number')
  })

  test('GET /trpc/system.echo round-trips through the mounted router (a query → GET)', async () => {
    const app = createApp(buildTestDeps())
    // tRPC queries are GET requests with the input JSON URL-encoded in `?input=`.
    const input = encodeURIComponent(JSON.stringify({ message: 'pong' }))
    const res = await app.request(`/trpc/system.echo?input=${input}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { data: { message: string } } }
    expect(body.result.data.message).toBe('pong')
  })

  test('GET /events streams an extraction:complete SSE message on job completion', async () => {
    const deps = buildTestDeps(activityPlusTaskScript())
    const app = createApp(deps)

    // Open the SSE stream.
    const res = await app.request('/events')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    if (!res.body) throw new Error('expected a streaming body')
    const reader = res.body.getReader()
    const decoder = new TextDecoder()

    // Enqueue a bullet + drain so the worker emits 'extraction:complete'.
    const bullet = createBullet(deps.db, { owner_id: deps.ownerId, text: 'ran 5k' })
    deps.runtime.enqueueExtraction(bullet.id, deps.ownerId)
    await deps.runtime.worker.drain()

    // Read until we have a complete SSE event frame (terminated by a blank line).
    let buffer = ''
    for (let i = 0; i < 10 && !buffer.includes('\n\n'); i += 1) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
    }

    expect(buffer).toContain('event: extraction:complete')
    // The data line carries the JSON payload with the bullet id.
    const dataLine = buffer.split('\n').find((l) => l.startsWith('data:'))
    expect(dataLine).toBeDefined()
    const payload = JSON.parse(dataLine?.slice('data:'.length).trim() ?? '{}') as {
      bulletId: string
      suggestionIds: string[]
      appliedIds: string[]
    }
    expect(payload.bulletId).toBe(bullet.id)
    expect(payload.suggestionIds.length).toBeGreaterThan(0)
    // The high-confidence activity was auto-applied.
    expect(payload.appliedIds.length).toBeGreaterThan(0)

    // While the stream is open it holds one listener per event.
    const emitter = deps.emitter as unknown as {
      listenerCount(event: string): number
    }
    expect(emitter.listenerCount('extraction:complete')).toBe(1)
    expect(emitter.listenerCount('extraction:error')).toBe(1)

    // Disconnect — this aborts the stream, which fires `onAbort` and detaches BOTH listeners.
    await reader.cancel()
    // Yield a macrotask so the stream's abort handler runs before we assert.
    await new Promise((resolve) => setTimeout(resolve, 0))

    // No leaked subscriptions: a regression that fails to detach (one leak per page) is caught.
    expect(emitter.listenerCount('extraction:complete')).toBe(0)
    expect(emitter.listenerCount('extraction:error')).toBe(0)
  })
})
