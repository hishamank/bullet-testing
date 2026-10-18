/** Server configuration, read from the environment once at startup. */

export interface ServerConfig {
  /** Interface to bind. Defaults to loopback; expose over Tailscale deliberately. */
  host: string
  port: number
  /** SQLite database file. */
  dbPath: string
  /** Directory holding voice-note recordings (kept forever). */
  audioDir: string
  /** llama.cpp `llama-server` root URL. */
  llmBaseUrl: string
  llmModel: string
  /** Optional llama-server `--api-key`. */
  llmApiKey: string | undefined
  /** Deadline for one model call. */
  llmTimeoutMs: number
  /**
   * whisper.cpp `whisper-server` root URL. Unset: no server transcription, so voice bullets are
   * processed on their device draft.
   */
  whisperBaseUrl: string | undefined
  /** The model whisper-server was started with, recorded on each server transcript. */
  whisperModel: string
  /** Optional initial prompt for Whisper (vocabulary / mixed-language style). */
  whisperPrompt: string | undefined
  /** Deadline for one transcription. */
  transcribeTimeoutMs: number
}

export function loadServerConfig(env: Record<string, string | undefined>): ServerConfig {
  return {
    host: env.HOST?.trim() || '127.0.0.1',
    port: Number(env.PORT) || 3001,
    dbPath: env.DB_PATH?.trim() || './data/bullet.db',
    audioDir: env.AUDIO_DIR?.trim() || './data/audio',
    llmBaseUrl: env.LLM_BASE_URL?.trim() || 'http://127.0.0.1:8080',
    llmModel: env.LLM_MODEL?.trim() || 'default',
    llmApiKey: env.LLM_API_KEY?.trim() || undefined,
    llmTimeoutMs: Number(env.LLM_TIMEOUT_MS) || 120_000,
    whisperBaseUrl: env.WHISPER_BASE_URL?.trim() || undefined,
    whisperModel: env.WHISPER_MODEL?.trim() || 'large-v3-turbo',
    whisperPrompt: env.WHISPER_PROMPT?.trim() || undefined,
    transcribeTimeoutMs: Number(env.TRANSCRIBE_TIMEOUT_MS) || 600_000,
  }
}
