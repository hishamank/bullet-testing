/**
 * @bullet/server — tRPC v11 router + the standalone local Node server.
 *
 * Every procedure is a thin (~10-line) wrapper over @bullet/core / @bullet/db / @bullet/agent —
 * DB access, the apply/commit engine, and the agent pipeline all live in those packages, never in
 * a procedure. The package exports the `AppRouter` TYPE for the web client and the `createApp` /
 * `buildServerContext` factories for embedding the server.
 */

export const PACKAGE_NAME = '@bullet/server'

// The Hono app factory (over injected singleton deps) — testable without a socket.
export { type CreateAppOptions, createApp } from './app'
// Server config (HTTP/process knobs + embedded agent config).
export {
  loadServerConfig,
  SERVER_CONFIG_DEFAULTS,
  type ServerConfig,
} from './config'
// Context + deps construction.
export {
  buildServerContext,
  type Context,
  contextFromDeps,
  createServerDeps,
  type ServerDeps,
} from './context'
// Single-user owner resolution.
export { DEFAULT_OWNER_NAME, getOrCreateDefaultOwner } from './owner'
// The app router + its type (the key export for the web client).
export { type AppRouter, appRouter } from './routers'
// The standalone-server entrypoint (also runnable via `tsx src/server.ts`).
export { startServer } from './server'
// SSE bridge (exported for tests / advanced embedding).
export { SSE_EVENTS, streamAgentEvents } from './sse'
// tRPC primitives (the caller factory is used by the integration tests).
export { createCallerFactory, publicProcedure, router } from './trpc'
