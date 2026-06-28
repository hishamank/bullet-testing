/**
 * The tRPC request context and the singleton dependency bundle behind it.
 *
 * The deps (db, ollama, runtime, emitter, config) are SINGLETONS built once at startup; `ownerId`
 * is the single-user owner resolved against the db. Every procedure reads from this context and
 * stays a thin wrapper — no procedure opens its own db, reads `process.env`, or constructs the
 * agent pipeline.
 *
 * `buildServerContext()` wires the real deps for the standalone server. Tests inject their own
 * deps (a `createTestDb` + a scripted Ollama) via `createServerDeps`/`contextFromDeps`, so the
 * whole surface is exercisable in-process without binding a socket.
 */

import {
  type AgentConfig,
  type AgentEmitter,
  type AgentRuntime,
  createAgentRuntime,
  HttpOllamaClient,
  loadAgentConfig,
  type OllamaClient,
} from '@bullet/agent'
import { createDb, type Db, type Sqlite } from '@bullet/db'
import { getOrCreateDefaultOwner } from './owner'

/**
 * The singleton dependencies shared by the tRPC procedures, the SSE route, and the worker. Built
 * once; threaded into every request context unchanged.
 */
export interface ServerDeps {
  db: Db
  ollama: OllamaClient
  config: AgentConfig
  emitter: AgentEmitter
  runtime: AgentRuntime
  ownerId: string
  /** The raw SQLite handle, kept so the standalone server can close it on shutdown. */
  sqlite?: Sqlite
}

/**
 * The per-request tRPC context. In v1 it is just the singleton deps (no per-request state, no
 * auth), so a request context is the deps bundle itself.
 */
export type Context = ServerDeps

/**
 * Assemble a {@link ServerDeps} from an already-open db + an Ollama client. Builds the agent
 * runtime (emitter + worker + helpers) and resolves the single owner. Used by both the real
 * server and the tests (which pass a `createTestDb` db + a scripted client).
 */
export function createServerDeps(args: {
  db: Db
  ollama: OllamaClient
  config: AgentConfig
  sqlite?: Sqlite
}): ServerDeps {
  const runtime = createAgentRuntime({ db: args.db, ollama: args.ollama, config: args.config })
  const ownerId = getOrCreateDefaultOwner(args.db)
  return {
    db: args.db,
    ollama: args.ollama,
    config: args.config,
    emitter: runtime.emitter,
    runtime,
    ownerId,
    sqlite: args.sqlite,
  }
}

/** A request context is the singleton deps — there is no per-request state in v1. */
export function contextFromDeps(deps: ServerDeps): Context {
  return deps
}

/**
 * Build the REAL server context: open the configured database (with migrations), construct the
 * HTTP Ollama client, wire the runtime, and resolve the owner. The standalone server calls this,
 * then starts `deps.runtime.worker`.
 */
export function buildServerContext(
  opts: { databasePath: string; config?: AgentConfig } = { databasePath: './bullet.db' },
): ServerDeps {
  const config = opts.config ?? loadAgentConfig()
  const { db, sqlite } = createDb(opts.databasePath, { migrate: true, wal: true })
  const ollama = new HttpOllamaClient({ baseUrl: config.baseUrl })
  return createServerDeps({ db, ollama, config, sqlite })
}
