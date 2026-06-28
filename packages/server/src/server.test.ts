/**
 * Graceful-shutdown regression test for the standalone server.
 *
 * Boots a REAL socket (ephemeral port) over injected test deps (in-memory db + scripted Ollama, so
 * no model and no db file), opens a live `GET /events` SSE connection — the long-lived connection
 * most likely to be open when the user stops the local server — and asserts `stop()` still resolves
 * and closes the db. Before the fix, `server.close()` waited for the SSE socket to end on its own,
 * so `stop()` hung forever and the db was never closed (the process died via the OS default
 * disposition instead of the graceful path).
 */

import { describe, expect, test } from 'vitest'
import { startServer } from './server'
import { buildTestDeps } from './test-helpers'

/** Reject if a promise has not settled within `ms` — turns a hung `stop()` into a test failure. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms),
    ),
  ])
}

describe('startServer — graceful shutdown over a real socket', () => {
  test('stop() resolves and closes the db even with an SSE client connected', async () => {
    const deps = buildTestDeps()
    // Port 0 → the OS picks a free ephemeral port (no clashes in CI / parallel runs).
    const { port, stop } = await startServer({ deps, port: 0 })
    expect(port).toBeGreaterThan(0)

    // Open a live SSE stream over the real socket. We do NOT read it to completion: it is a
    // long-lived connection that never ends on its own — exactly the case that used to hang close().
    const controller = new AbortController()
    const res = await fetch(`http://localhost:${port}/events`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    // The fix force-terminates lingering sockets so close() can complete. A generous 5s ceiling:
    // the bug manifests as an unbounded hang, so any reasonable timeout proves the regression.
    await withTimeout(stop(), 5000, 'stop() with an open SSE client')

    // The graceful path must have reached `deps.sqlite?.close()` — proving stop() did not hang
    // before it. better-sqlite3 reports the handle as closed via `open === false`.
    expect(deps.sqlite?.open).toBe(false)
    // Releasing the client-side socket so the test process can exit cleanly.
    controller.abort()
  })

  test('stop() is idempotent (second call is a no-op)', async () => {
    const deps = buildTestDeps()
    const { stop } = await startServer({ deps, port: 0 })
    await withTimeout(stop(), 5000, 'first stop()')
    // A second stop() must not throw or hang (the db is already closed).
    await expect(withTimeout(stop(), 5000, 'second stop()')).resolves.toBeUndefined()
  })
})
