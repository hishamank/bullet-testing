/** Server configuration, read from the environment once at startup. */

import {
  DEDICATED_PROFILE,
  ENGINE_CONFIG_DEFAULTS,
  type EmbeddingProfile,
  type EngineConfig,
  LLM_PROFILE,
  type LinkThresholds,
  profileForModel,
} from '@bullet/engine'

export interface ServerConfig {
  /** Interface to bind. Defaults to loopback; expose over Tailscale deliberately. */
  host: string
  port: number
  /** SQLite database file. */
  dbPath: string
  /** Directory holding voice-note recordings (kept forever). */
  audioDir: string
  /** The built web app to serve at `/` (`apps/web/dist`); unset = the default location. */
  webDir: string | undefined
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
  /** The nightly model (themes, link review); unset = the live model. */
  llmNightlyModel: string | undefined
  /** Its server, when it runs on another llama-server; unset = `llmBaseUrl`. */
  llmNightlyBaseUrl: string | undefined
  /** Embeddings (`/v1/embeddings`): a llama-server started with `--embeddings`. */
  embedBaseUrl: string
  embedModel: string
  embedApiKey: string | undefined
  embedTimeoutMs: number
  /** How similarity is read: thresholds and centring for this kind of model. */
  embedProfile: EmbeddingProfile
  /** The server's zone, for the nightly 02:00. */
  timezone: string
}

const num = (v: string | undefined): number | undefined => {
  const n = Number(v)
  return v === undefined || v.trim() === '' || !Number.isFinite(n) ? undefined : n
}

/**
 * The embedding profile: `EMBED_PROFILE` (`dedicated` | `llm`); else `llm` when no
 * `EMBED_BASE_URL` is set (embeddings then come from the chat model's own server, a chat model);
 * else guessed from the model name;
 * each threshold can be overridden (`LINK_THRESHOLD`, `LINK_ENTITY_THRESHOLD`,
 * `ANSWER_CHECK_THRESHOLD`, `CONNECTION_QUESTION_THRESHOLD`, `LINK_REVIEW_BELOW`).
 */
export function embedProfile(
  env: Record<string, string | undefined>,
  model: string,
): EmbeddingProfile {
  const named = env.EMBED_PROFILE?.trim().toLowerCase()
  const base =
    named === 'llm'
      ? LLM_PROFILE
      : named === 'dedicated'
        ? DEDICATED_PROFILE
        : !env.EMBED_BASE_URL?.trim()
          ? LLM_PROFILE
          : profileForModel(model)
  const t: LinkThresholds = {
    link: num(env.LINK_THRESHOLD) ?? base.thresholds.link,
    linkSharedEntity: num(env.LINK_ENTITY_THRESHOLD) ?? base.thresholds.linkSharedEntity,
    answerCheck: num(env.ANSWER_CHECK_THRESHOLD) ?? base.thresholds.answerCheck,
    connectionQuestion:
      num(env.CONNECTION_QUESTION_THRESHOLD) ?? base.thresholds.connectionQuestion,
    reviewBelow: num(env.LINK_REVIEW_BELOW) ?? base.thresholds.reviewBelow,
  }
  return { ...base, thresholds: t }
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
    webDir: env.WEB_DIR?.trim() || undefined,
    llmBaseUrl: env.LLM_BASE_URL?.trim() || 'http://127.0.0.1:8080',
    llmModel: env.LLM_MODEL?.trim() || 'default',
    llmApiKey: env.LLM_API_KEY?.trim() || undefined,
    llmTimeoutMs: Number(env.LLM_TIMEOUT_MS) || 120_000,
    whisperBaseUrl: env.WHISPER_BASE_URL?.trim() || undefined,
    whisperModel: env.WHISPER_MODEL?.trim() || 'large-v3-turbo',
    whisperPrompt: env.WHISPER_PROMPT?.trim() || undefined,
    transcribeTimeoutMs: Number(env.TRANSCRIBE_TIMEOUT_MS) || 600_000,
    autoApplyValueRecords: envFlag(env.AUTO_APPLY_VALUE_RECORDS),
    llmNightlyModel: env.LLM_NIGHTLY_MODEL?.trim() || undefined,
    llmNightlyBaseUrl: env.LLM_NIGHTLY_BASE_URL?.trim() || undefined,
    embedBaseUrl: env.EMBED_BASE_URL?.trim() || env.LLM_BASE_URL?.trim() || 'http://127.0.0.1:8080',
    embedModel: env.EMBED_MODEL?.trim() || env.LLM_MODEL?.trim() || 'default',
    embedApiKey: env.EMBED_API_KEY?.trim() || env.LLM_API_KEY?.trim() || undefined,
    embedTimeoutMs: Number(env.EMBED_TIMEOUT_MS) || 60_000,
    embedProfile: embedProfile(env, env.EMBED_MODEL?.trim() || env.LLM_MODEL?.trim() || 'default'),
    timezone: env.TZ?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  }
}

/** The nightly run's engine settings: its model label (the live model's when unset). */
export function nightlyEngineConfig(config: ServerConfig): EngineConfig {
  return { ...engineConfig(config), model: config.llmNightlyModel ?? config.llmModel }
}

/** The engine's settings from the server's: the model label and the auto-apply gates. */
export function engineConfig(config: ServerConfig): EngineConfig {
  return {
    ...ENGINE_CONFIG_DEFAULTS,
    model: config.llmModel,
    autoApplyValueRecords: config.autoApplyValueRecords,
  }
}
