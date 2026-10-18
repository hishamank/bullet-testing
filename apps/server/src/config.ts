/** Server configuration, read from the environment once at startup. */

import { ENGINE_CONFIG_DEFAULTS, type EngineConfig } from '@bullet/engine'

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
  /**
   * Let confident readings with a value (mood 4, weight 72, ran 5 km) apply automatically.
   * Default false: they wait for a tap, so a wrong value is never written silently.
   */
  autoApplyValueRecords: boolean
}

/** "true", "1", "yes" or "on" (any case) → true; anything else, or unset → false. */
export function envFlag(value: string | undefined): boolean {
  return ['true', '1', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '')
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
    autoApplyValueRecords: envFlag(env.AUTO_APPLY_VALUE_RECORDS),
  }
}

/** The engine's settings from the server's: the model label and the auto-apply gates. */
export function engineConfig(config: ServerConfig): EngineConfig {
  return {
    ...ENGINE_CONFIG_DEFAULTS,
    model: config.llmModel,
    autoApplyValueRecords: config.autoApplyValueRecords,
  }
}
