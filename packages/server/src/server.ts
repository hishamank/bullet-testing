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
import { buildServerContext, type ServerDeps } from './context'

/**
 * Options for {@link startServer}. All optional: by default the server loads config from the
 * environment and opens the real db + HTTP Ollama client. Tests inject `deps` (an in-memory db +
 * a scripted Ollama) and `port: 0` (an OS-chosen ephemeral port) to exercise the real socket and
 * the graceful-shutdown path without touching the model or the filesystem.
 */
export interface StartServerOptions {
  /** Pre-built singleton deps. When omitted, the real context is built from config. */
  deps?: ServerDeps
  /** Override the listen port (`0` lets the OS pick a free port — handy for tests). */
  port?: number
}

/**
 * Boot the server. Returns the bound `port` and a `stop()` for programmatic shutdown (used by the
 * boot smoke test); when run directly it also wires SIGINT/SIGTERM to the same path.
 */
export async function startServer(
  opts: StartServerOptions = {},
): Promise<{ port: number; stop: () => Promise<void> }> {
  const config = loadServerConfig()

  // Singleton deps: open the db (migrate), wire the HTTP Ollama client + the agent runtime.
  // Tests inject their own deps (in-memory db + scripted Ollama) so no model/socket is required.
  const deps =
    opts.deps ?? buildServerContext({ databasePath: config.databasePath, config: config.agent })

  // Start draining the extraction queue (single GPU slot) BEFORE serving requests.
  deps.runtime.worker.start()

  const app = createApp(deps, { corsOrigin: config.corsOrigin })
  const port = opts.port ?? config.port
  const server = serve({ fetch: app.fetch, port })
  // The OS may have chosen an ephemeral port (`port: 0`); report the one actually bound.
  const boundPort = (server.address() as { port: number } | null)?.port ?? port

  const url = `http://localhost:${boundPort}`
  console.log(`[@bullet/server] listening on ${url} (db: ${config.databasePath})`)

  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    deps.runtime.worker.stop()
    // `server.close()` only STOPS ACCEPTING new connections, then waits for all existing ones to
    // end before its callback fires. A `GET /events` SSE stream is a long-lived connection that
    // never ends on its own, so a single open browser tab would otherwise hang shutdown forever
    // (stop() never resolves, the db never closes). Force-terminate lingering sockets right after
    // requesting close so the callback can run. `closeAllConnections` exists on Node 18.2+/24.
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      ;(server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
    })
    deps.sqlite?.close()
    console.log('[@bullet/server] stopped')
  }

  return { port: boundPort, stop }
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
