/**
 * First-run device setup (pure): validate the home server address and token, and check them
 * against the server with one tiny pull before saving.
 */

import type { SyncTransport, TransportError } from '../../sync/transport'

export type UrlResult = { ok: true; url: string } | { ok: false; error: string }

/**
 * Accepts `host[:port][/prefix]` with or without a scheme. Without one, https is assumed (a
 * Tailscale `serve` address); plain http must be typed explicitly.
 */
export function normalizeServerUrl(input: string): UrlResult {
  const raw = input.trim()
  if (raw === '') return { ok: false, error: 'Enter your home server address.' }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return { ok: false, error: "That doesn't look like an address." }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Use an http:// or https:// address.' }
  }
  if (url.hostname === '') return { ok: false, error: "That doesn't look like an address." }
  if (url.search || url.hash) return { ok: false, error: 'Leave out anything after ? or #.' }
  const path = url.pathname.replace(/\/+$/, '')
  return { ok: true, url: `${url.protocol}//${url.host}${path}` }
}

export type TokenResult = { ok: true; token: string } | { ok: false; error: string }

export function normalizeToken(input: string): TokenResult {
  const token = input.trim()
  if (token === '') return { ok: false, error: 'Paste the device token.' }
  if (/\s/.test(token)) return { ok: false, error: 'The token has no spaces in it.' }
  return { ok: true, token }
}

export type ConnectionCheck = 'ok' | 'unauthorized' | 'unreachable' | 'unexpected'

/** One small pull proves the address, the token and the contract in one go. */
export async function checkConnection(transport: SyncTransport): Promise<ConnectionCheck> {
  try {
    await transport.pull({ limit: 1 })
    return 'ok'
  } catch (err) {
    const kind = (err as Partial<TransportError>).kind
    if (kind === 'unauthorized') return 'unauthorized'
    if (kind === 'network') return 'unreachable'
    return 'unexpected'
  }
}

export const CHECK_MESSAGES: Record<Exclude<ConnectionCheck, 'ok'>, string> = {
  unauthorized: "The server didn't accept this token. Check it and try again.",
  unreachable:
    "Couldn't reach the server from here. Check the address, or save anyway and it will sync when it can.",
  unexpected: 'The server answered, but not like a Bullet home server. Check the address.',
}
