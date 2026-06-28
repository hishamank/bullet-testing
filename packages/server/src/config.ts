/**
 * Server configuration from the environment. The HTTP/process concerns (port, db path, CORS
 * origin) live here; the model/threshold settings are delegated to the agent's `loadAgentConfig`
 * so there is a single source of truth for Ollama wiring.
 */

import { type AgentConfig, type AgentEnv, loadAgentConfig } from '@bullet/agent'
import { DEFAULT_DATABASE_PATH } from '@bullet/db'

/** Defaults applied when the matching env var is absent. Kept in one place for the README/tests. */
export const SERVER_CONFIG_DEFAULTS = {
  port: 3001,
  databasePath: DEFAULT_DATABASE_PATH,
  /** The web dev origin allowed by CORS (Next.js default). */
  corsOrigin: 'http://localhost:3000',
} as const

/** Resolved server configuration: the HTTP/process knobs plus the embedded agent config. */
export interface ServerConfig {
  port: number
  databasePath: string
  /** Allowed CORS origin(s) for the browser client. A single origin, or '*' to allow any. */
  corsOrigin: string
  /** The agent's Ollama/model/threshold settings (single source of truth). */
  agent: AgentConfig
}

/** Parse an integer env var, falling back when absent or not a finite integer. */
function intFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Build a {@link ServerConfig} from environment variables.
 *
 * Recognised vars (plus everything `loadAgentConfig` reads):
 *   PORT, DATABASE_PATH, CORS_ORIGIN
 */
export function loadServerConfig(env: AgentEnv = process.env): ServerConfig {
  const d = SERVER_CONFIG_DEFAULTS
  return {
    port: intFromEnv(env.PORT, d.port),
    databasePath: env.DATABASE_PATH?.trim() || d.databasePath,
    corsOrigin: env.CORS_ORIGIN?.trim() || d.corsOrigin,
    agent: loadAgentConfig(env),
  }
}
