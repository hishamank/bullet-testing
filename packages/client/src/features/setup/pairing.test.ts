import { describe, expect, it } from 'vite-plus/test'
import { createHttpTransport } from '../../sync/transport'
import { checkConnection, normalizeServerUrl, normalizeToken } from './pairing'

describe('server address', () => {
  it('assumes https and drops trailing slashes', () => {
    expect(normalizeServerUrl(' mac.tailnet.ts.net/ ')).toEqual({
      ok: true,
      url: 'https://mac.tailnet.ts.net',
    })
    expect(normalizeServerUrl('http://100.64.0.2:3001/bullet//')).toEqual({
      ok: true,
      url: 'http://100.64.0.2:3001/bullet',
    })
  })

  it('refuses what cannot be a server address', () => {
    for (const bad of ['', '   ', 'ftp://x', 'https://x?y=1', 'http://']) {
      expect(normalizeServerUrl(bad).ok, bad).toBe(false)
    }
  })
})

describe('device token', () => {
  it('trims and refuses blanks or spaces', () => {
    expect(normalizeToken(' abc ')).toEqual({ ok: true, token: 'abc' })
    expect(normalizeToken('').ok).toBe(false)
    expect(normalizeToken('ab c').ok).toBe(false)
  })
})

describe('connection check', () => {
  const transport = (respond: () => Promise<Response>) =>
    createHttpTransport({ baseUrl: 'https://home', token: 't', fetch: respond as typeof fetch })
  const json = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }))

  it('is ok when a pull answers on-contract', async () => {
    const page = {
      changes: Object.fromEntries(
        [
          'bullets',
          'suggestions',
          'tasks',
          'events',
          'trackers',
          'tracker_entries',
          'activities',
          'audio_attachments',
          'transcripts',
          'thoughts',
          'questions',
        ].map((k) => [k, []]),
      ),
      cursor: 'c1',
      has_more: false,
      server_time: 1,
    }
    expect(await checkConnection(transport(() => json(page)))).toBe('ok')
  })

  it('tells a refused token from an unreachable server from something else', async () => {
    expect(await checkConnection(transport(() => json({}, 401)))).toBe('unauthorized')
    expect(await checkConnection(transport(() => Promise.reject(new Error('offline'))))).toBe(
      'unreachable',
    )
    expect(await checkConnection(transport(() => json({ hello: 'world' })))).toBe('unexpected')
  })
})
