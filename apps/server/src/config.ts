/** Server configuration, read from the environment once at startup. */

export interface ServerConfig {
  /** Interface to bind. Defaults to loopback; expose over Tailscale deliberately. */
  host: string
  port: number
  /** llama.cpp `llama-server` root URL. */
  llmBaseUrl: string
  llmModel: string
}

export function loadServerConfig(env: Record<string, string | undefined>): ServerConfig {
  return {
    host: env.HOST?.trim() || '127.0.0.1',
    port: Number(env.PORT) || 3001,
    llmBaseUrl: env.LLM_BASE_URL?.trim() || 'http://127.0.0.1:8080',
    llmModel: env.LLM_MODEL?.trim() || 'default',
  }
}
