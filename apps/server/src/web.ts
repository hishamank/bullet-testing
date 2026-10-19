import { serveStatic } from '@hono/node-server/serve-static'
import type { MiddlewareHandler } from 'hono'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Serving the built web app (`apps/web/dist`) from the home server, at `/`. A static-file edge
 * only: no domain logic. It sits in front of the auth check on purpose: the files hold no data,
 * and the app itself needs a device token (in this browser) before it can read anything. The
 * sync API paths are untouched and still require a bearer token.
 *
 * The page is same-origin with the API, makes no third-party request (the headers below enforce
 * it) and needs `wasm-unsafe-eval` only for its bundled SQLite (sql.js, WebAssembly).
 */

/** Where the web build is, unless `WEB_DIR` says otherwise: `apps/web/dist` next to this app. */
export function defaultWebDir(): string {
  return resolve(import.meta.dirname, '../../web/dist')
}

/** The built web app, when there is one (`index.html` present). */
export function findWebRoot(dir: string): string | null {
  const root = resolve(dir)
  return existsSync(join(root, 'index.html')) ? root : null
}

export const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  // The palette is installed as a <style> element at start-up.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

/** GET/HEAD for files under `root`; anything else (or no such file) falls through to the API. */
export function serveWeb(root: string): MiddlewareHandler {
  const files = serveStatic({ root })
  return async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next()
    let fellThrough = false
    const res = await files(c, async () => {
      fellThrough = true
      return next()
    })
    if (fellThrough || !res) return res
    res.headers.set('Content-Security-Policy', WEB_CSP)
    res.headers.set('X-Content-Type-Options', 'nosniff')
    res.headers.set('Referrer-Policy', 'no-referrer')
    res.headers.set('X-Frame-Options', 'DENY')
    // Built files are named by content: keep them for good. The page itself is always rechecked.
    res.headers.set(
      'Cache-Control',
      c.req.path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    )
    return res
  }
}
