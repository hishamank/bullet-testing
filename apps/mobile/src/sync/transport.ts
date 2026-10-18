/**
 * HTTP transport for the sync API. Plain `fetch`, responses validated against the contract
 * schemas before they can touch the local database. Failures are classified so the client knows
 * whether to retry later (network/server), stop (unauthorized) or isolate a bad op (bad_request).
 */

import {
  type PullResponse,
  pullResponseSchema,
  type PushRequest,
  type PushResponse,
  pushResponseSchema,
} from '@bullet/core'

export type TransportErrorKind = 'network' | 'unauthorized' | 'bad_request' | 'server'

export class TransportError extends Error {
  readonly kind: TransportErrorKind
  readonly status?: number
  constructor(kind: TransportErrorKind, message: string, status?: number) {
    super(message)
    this.name = 'TransportError'
    this.kind = kind
    this.status = status
  }
}

export interface SyncTransport {
  push(req: PushRequest): Promise<PushResponse>
  pull(query: { cursor?: string; limit?: number }): Promise<PullResponse>
}

export interface HttpTransportOptions {
  /** Home server root, e.g. `http://my-mac.tailnet.ts.net:3001`. */
  baseUrl: string
  /** The device bearer token. */
  token: string
  timeoutMs?: number
  fetch?: typeof fetch
}

export function createHttpTransport(opts: HttpTransportOptions): SyncTransport {
  const base = opts.baseUrl.replace(/\/+$/, '')
  const doFetch = opts.fetch ?? fetch
  const timeoutMs = opts.timeoutMs ?? 30_000

  async function call(
    path: string,
    init: { method: string; body?: string; headers?: Record<string, string> },
  ): Promise<unknown> {
    let res: Response
    try {
      res = await doFetch(`${base}${path}`, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${opts.token}` },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      throw new TransportError('network', `cannot reach the home server: ${String(err)}`)
    }
    if (res.status === 401) throw new TransportError('unauthorized', 'device token rejected', 401)
    if (res.status === 400 || res.status === 413) {
      throw new TransportError('bad_request', await res.text(), res.status)
    }
    if (!res.ok) throw new TransportError('server', `server responded ${res.status}`, res.status)
    try {
      return await res.json()
    } catch {
      throw new TransportError('server', 'server sent invalid JSON')
    }
  }

  return {
    async push(req) {
      const body = await call('/sync/push', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
      })
      const parsed = pushResponseSchema.safeParse(body)
      if (!parsed.success) throw new TransportError('server', 'push response off-contract')
      return parsed.data
    },
    async pull({ cursor, limit }) {
      const q = new URLSearchParams()
      if (cursor !== undefined) q.set('cursor', cursor)
      if (limit !== undefined) q.set('limit', String(limit))
      const body = await call(`/sync/pull?${q.toString()}`, { method: 'GET' })
      const parsed = pullResponseSchema.safeParse(body)
      if (!parsed.success) throw new TransportError('server', 'pull response off-contract')
      return parsed.data
    },
  }
}
