import { type ApiError, MAX_PULL_LIMIT, pullQuerySchema, pushRequestSchema } from '@bullet/core'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { authenticate } from './auth/devices'
import type { Db } from './db/client'
import { InvalidCursorError, parseCursor, pullChanges } from './sync/changes'
import { pushOps } from './sync/push'

/**
 * The HTTP app. Thin wrappers only: parse + authenticate, call a domain function, serialise.
 * Every route requires a device bearer token.
 */

export interface AppDeps {
  db: Db
  now?: () => number
  /** Called after a push queued processing work (wakes the worker). */
  onWorkQueued?: () => void
  onError?: (err: unknown) => void
}

type Env = { Variables: { ownerId: string; deviceId: string } }

const apiError = (code: ApiError['error']['code'], message: string): ApiError => ({
  error: { code, message },
})

export function createApp(deps: AppDeps) {
  const now = deps.now ?? Date.now
  const app = new Hono<Env>()

  app.onError((err, c) => {
    deps.onError?.(err)
    return c.json(apiError('internal', 'internal error'), 500)
  })
  app.notFound((c) => c.json(apiError('not_found', 'no such route'), 404))

  app.use('*', async (c, next) => {
    const header = c.req.header('authorization') ?? ''
    const match = /^Bearer\s+(\S+)$/i.exec(header)
    const device = match?.[1] ? authenticate(deps.db, match[1], now()) : null
    if (!device) return c.json(apiError('unauthorized', 'missing or invalid device token'), 401)
    c.set('ownerId', device.ownerId)
    c.set('deviceId', device.deviceId)
    await next()
  })

  app.get('/health', (c) => c.json({ ok: true }))

  app.post(
    '/sync/push',
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) => c.json(apiError('payload_too_large', 'push body over 1 MiB'), 413),
    }),
    async (c) => {
      const body: unknown = await c.req.json().catch(() => undefined)
      const parsed = pushRequestSchema.safeParse(body)
      if (!parsed.success) {
        return c.json(apiError('bad_request', parsed.error.issues[0]?.message ?? 'bad body'), 400)
      }
      const { results, queuedWork } = pushOps(deps.db, c.get('ownerId'), parsed.data.ops, now)
      if (queuedWork) deps.onWorkQueued?.()
      return c.json({ results, server_time: now() })
    },
  )

  app.get('/sync/pull', (c) => {
    const parsed = pullQuerySchema.safeParse(c.req.query())
    if (!parsed.success) return c.json(apiError('bad_request', 'invalid pull query'), 400)
    let cursor: number
    try {
      cursor = parseCursor(parsed.data.cursor)
    } catch (err) {
      if (err instanceof InvalidCursorError)
        return c.json(apiError('bad_request', err.message), 400)
      throw err
    }
    const page = pullChanges(deps.db, c.get('ownerId'), cursor, parsed.data.limit ?? MAX_PULL_LIMIT)
    return c.json({ ...page, server_time: now() })
  })

  return app
}
