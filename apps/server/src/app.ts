import { Hono } from 'hono'

/**
 * The HTTP app. Thin wrappers only: business logic lives in `@bullet/core` / `@bullet/engine`.
 * Sync ingest, processing status and suggestions arrive with the capture-loop slice.
 */
export function createApp() {
  const app = new Hono()
  app.get('/health', (c) => c.json({ ok: true }))
  return app
}
