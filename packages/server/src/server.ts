/**
 * The standalone local Node server — the "always a local server" piece. Runs with `tsx` WITHOUT
 * Next: it loads config from the environment, opens the database (with migrations), builds the
 * HTTP Ollama client + the agent runtime, ensures the single owner exists, mounts the Hono app,
 * STARTS THE QUEUE WORKER, and serves over @hono/node-server. SIGINT/SIGTERM shut it down
 * gracefully (stop the worker, close the db).
 */

import { serve } from '@hono/node-server'
import { createApp } from './app'
import { loadServerConfig } from './config'
import { buildServerContext } from './context'

/**
 * Boot the server. Returns a `stop()` for programmatic shutdown (used by the boot smoke test);
 * when run directly it also wires SIGINT/SIGTERM to the same path.
 */
export async function startServer(): Promise<{ port: number; stop: () => Promise<void> }> {
  const config = loadServerConfig()

  // Singleton deps: open the db (migrate), wire the HTTP Ollama client + the agent runtime.
  const deps = buildServerContext({ databasePath: config.databasePath, config: config.agent })

  // Start draining the extraction queue (single GPU slot) BEFORE serving requests.
  deps.runtime.worker.start()

  const app = createApp(deps, { corsOrigin: config.corsOrigin })
  const server = serve({ fetch: app.fetch, port: config.port })

  const url = `http://localhost:${config.port}`
  console.log(`[@bullet/server] listening on ${url} (db: ${config.databasePath})`)

  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    deps.runtime.worker.stop()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    deps.sqlite?.close()
    console.log('[@bullet/server] stopped')
  }

  return { port: config.port, stop }
}

/** True when this module is the program's entry point (run via `tsx src/server.ts`). */
const isMain = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  return import.meta.url === new URL(`file://${entry}`).href || import.meta.url.endsWith(entry)
})()

if (isMain) {
  startServer()
    .then(({ stop }) => {
      const shutdown = (signal: string): void => {
        console.log(`[@bullet/server] received ${signal}, shutting down…`)
        stop().then(
          () => process.exit(0),
          (err) => {
            console.error(err)
            process.exit(1)
          },
        )
      }
      process.on('SIGINT', () => shutdown('SIGINT'))
      process.on('SIGTERM', () => shutdown('SIGTERM'))
    })
    .catch((err) => {
      console.error('[@bullet/server] failed to start', err)
      process.exit(1)
    })
}
