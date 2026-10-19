import {
  type ApiError,
  AUDIO_UPLOAD_OFFSET_HEADER,
  MAX_AUDIO_CHUNK_BYTES,
  MAX_PULL_LIMIT,
  pullQuerySchema,
  pushRequestSchema,
} from '@bullet/core'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { ApplyError } from './apply/apply'
import { authenticate } from './auth/devices'
import {
  ChecksumMismatchError,
  parseByteRange,
  readAudio,
  receiveAudioChunk,
  uploadState,
} from './capture/audio'
import type { AudioStore } from './storage/audio-store'
import type { Db } from './db/client'
import { InvalidCursorError, parseCursor, pullChanges } from './sync/changes'
import { pushOps } from './sync/push'
import { serveWeb } from './web'

/**
 * The HTTP app. Thin wrappers only: parse + authenticate, call a domain function, serialise.
 * Every route requires a device bearer token.
 */

export interface AppDeps {
  db: Db
  audioStore: AudioStore
  now?: () => number
  /** Called after a push queued processing work (wakes the worker). */
  onWorkQueued?: () => void
  onError?: (err: unknown) => void
  /**
   * The built web app (`apps/web/dist`) to serve at `/`, with no auth: the files hold no data and
   * the app needs a device token to read anything. Unset: the server is API-only.
   */
  webRoot?: string
}

type Env = { Variables: { ownerId: string; deviceId: string } }

const apiError = (code: ApiError['error']['code'], message: string): ApiError => ({
  error: { code, message },
})

export function createApp(deps: AppDeps) {
  const now = deps.now ?? Date.now
  const app = new Hono<Env>()

  app.onError((err, c) => {
    if (err instanceof ApplyError) {
      const status = { not_found: 404, conflict: 409, invalid: 400, stale: 409 } as const
      const code = {
        not_found: 'not_found',
        conflict: 'conflict',
        invalid: 'bad_request',
        stale: 'conflict',
      } as const
      return c.json(apiError(code[err.code], err.message), status[err.code])
    }
    if (err instanceof ChecksumMismatchError) {
      return c.json(apiError('unprocessable', err.message), 422)
    }
    deps.onError?.(err)
    return c.json(apiError('internal', 'internal error'), 500)
  })
  app.notFound((c) => c.json(apiError('not_found', 'no such route'), 404))

  if (deps.webRoot) app.use('*', serveWeb(deps.webRoot))

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

  const isUuid = (id: string) => /^[0-9a-f-]{36}$/i.test(id)

  app.get('/sync/audio/:id/status', (c) => {
    const id = c.req.param('id')
    if (!isUuid(id)) return c.json(apiError('bad_request', 'invalid id'), 400)
    return c.json(uploadState(deps.db, c.get('ownerId'), id))
  })

  app.put(
    '/sync/audio/:id',
    bodyLimit({
      maxSize: MAX_AUDIO_CHUNK_BYTES,
      onError: (c) => c.json(apiError('payload_too_large', 'audio chunk over 4 MiB'), 413),
    }),
    async (c) => {
      const id = c.req.param('id')
      const offset = Number(c.req.header(AUDIO_UPLOAD_OFFSET_HEADER))
      if (!isUuid(id) || !Number.isInteger(offset) || offset < 0) {
        return c.json(apiError('bad_request', `invalid id or ${AUDIO_UPLOAD_OFFSET_HEADER}`), 400)
      }
      const bytes = new Uint8Array(await c.req.arrayBuffer())
      const owner = c.get('ownerId')
      const state = receiveAudioChunk(deps.db, deps.audioStore, owner, id, offset, bytes, now())
      if (state.upload_status === 'uploaded') deps.onWorkQueued?.()
      return c.json(state)
    },
  )

  app.get('/sync/audio/:id', (c) => {
    const id = c.req.param('id')
    if (!isUuid(id)) return c.json(apiError('bad_request', 'invalid id'), 400)
    const { bytes, mimeType } = readAudio(deps.db, deps.audioStore, c.get('ownerId'), id)
    // Byte ranges let a player (AVPlayer) seek without downloading the whole recording again.
    const base = { 'content-type': mimeType, 'accept-ranges': 'bytes' }
    const range = parseByteRange(c.req.header('range'), bytes.length)
    if (range === 'unsatisfiable') {
      return c.body(null, 416, { ...base, 'content-range': `bytes */${bytes.length}` })
    }
    if (range) {
      const part = bytes.slice(range.start, range.end + 1)
      return c.body(part.buffer, 206, {
        ...base,
        'content-length': String(part.length),
        'content-range': `bytes ${range.start}-${range.end}/${bytes.length}`,
      })
    }
    return c.body(bytes.slice().buffer, 200, { ...base, 'content-length': String(bytes.length) })
  })

  return app
}
