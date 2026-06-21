/**
 * The Hono application — the HTTP surface around the tRPC router + the SSE stream.
 *
 * `createApp(deps)` takes the SINGLETON deps so it is fully testable: a test builds the app over
 * a `createTestDb` + a scripted Ollama and drives it with `app.request(...)`, never binding a
 * socket. The standalone server (`server.ts`) passes the real deps and serves the same app.
 *
 * Routes:
 *   - `/trpc/*` — the app router via @hono/trpc-server (context = the singleton deps).
 *   - `GET /events` — the agent-events SSE stream.
 *   - `GET /health` — a tiny liveness probe (also surfaced as the `system.health` procedure).
 */

import { trpcServer } from '@hono/trpc-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { contextFromDeps, type ServerDeps } from './context'
import { appRouter } from './routers'
import { streamAgentEvents } from './sse'

export interface CreateAppOptions {
  /** Allowed CORS origin for the browser client (defaults to the Next.js dev origin). */
  corsOrigin?: string
}

/** Build the Hono app over the given singleton deps. Does NOT start the worker (the caller does). */
export function createApp(deps: ServerDeps, opts: CreateAppOptions = {}): Hono {
  const app = new Hono()

  // Allow the web dev origin to call the API + read the SSE stream from the browser.
  app.use(
    '*',
    cors({
      origin: opts.corsOrigin ?? 'http://localhost:3000',
      allowMethods: ['GET', 'POST', 'OPTIONS'],
    }),
  )

  // Liveness probe (cheap, dependency-free).
  app.get('/health', (c) => c.json({ ok: true, now: Date.now() }))

  // Stream extraction-complete / -error events to the browser.
  app.get('/events', (c) => streamAgentEvents(c, deps.emitter))

  // Mount the tRPC router. Every request shares the singleton deps as its context (no per-request
  // state in v1) — so procedures stay thin wrappers over the injected db/runtime.
  app.use(
    '/trpc/*',
    trpcServer({
      router: appRouter,
      endpoint: '/trpc',
      // The Hono adapter types `createContext` as returning a `Record<string, unknown>`; our
      // Context is the singleton deps object. The cast bridges the adapter's loose shape to the
      // router's exact Context (which tRPC enforces inside the procedures).
      createContext: (): Record<string, unknown> =>
        contextFromDeps(deps) as unknown as Record<string, unknown>,
    }),
  )

  return app
}
