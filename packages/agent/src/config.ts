/**
 * Agent configuration — loaded from the environment with sane defaults.
 *
 * The whole agent pipeline is built on DEPENDENCY INJECTION: every function takes a `deps`
 * bundle (`{ db, ollama, config, emitter }`), so the config is a plain value, never read from
 * `process.env` deep inside the pipeline. `loadAgentConfig` is the one place env is consulted
 * (by the Task 4 server at startup); tests construct `AgentConfig` literals directly.
 */

/**
 * Resolved agent configuration.
 *
 *  - `baseUrl`        — the Ollama HTTP endpoint.
 *  - `liveModel`      — the model used for per-bullet (interactive) extraction.
 *  - `weeklyModel`    — the model used for the (heavier, batch) weekly analysis.
 *  - `autoThreshold`  — confidence at/above which an eligible RECORD/UPDATE suggestion is
 *                       tier `auto` (and gets auto-applied). Definitions are never `auto`.
 *  - `suggestThreshold` — confidence at/above which a suggestion is at least `suggest`
 *                       (below it is `ask`).
 *  - `autoCreateTasks` — when false (the default, conservative), task CREATEs are capped at
 *                       `suggest` and never auto-applied (CLAUDE.md §4.5: eagerness scales
 *                       inversely with permanence; we do not silently mint task lists).
 */
export interface AgentConfig {
  baseUrl: string
  liveModel: string
  weeklyModel: string
  autoThreshold: number
  suggestThreshold: number
  autoCreateTasks: boolean
}

/** The defaults applied when an env var is absent. Kept in one place for the README/tests. */
export const AGENT_CONFIG_DEFAULTS: AgentConfig = {
  baseUrl: 'http://localhost:11434',
  liveModel: 'gemma3:4b',
  weeklyModel: 'gemma3:4b',
  autoThreshold: 0.85,
  suggestThreshold: 0.5,
  autoCreateTasks: false,
}

/** A minimal view of the environment (so tests can pass a plain object). */
export type AgentEnv = Record<string, string | undefined>

/** Parse a float env var, falling back to `fallback` when absent or not a finite number. */
function numberFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

/** Parse a boolean env var ('1'/'true'/'yes' → true), falling back when absent. */
function booleanFromEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())
}

/**
 * Build an {@link AgentConfig} from environment variables, applying
 * {@link AGENT_CONFIG_DEFAULTS} for anything unset.
 *
 * Recognised vars:
 *   OLLAMA_BASE_URL, OLLAMA_LIVE_MODEL, OLLAMA_WEEKLY_MODEL,
 *   AGENT_AUTO_THRESHOLD, AGENT_SUGGEST_THRESHOLD, AGENT_AUTO_CREATE_TASKS
 */
export function loadAgentConfig(env: AgentEnv = process.env): AgentConfig {
  const d = AGENT_CONFIG_DEFAULTS
  return {
    baseUrl: env.OLLAMA_BASE_URL?.trim() || d.baseUrl,
    liveModel: env.OLLAMA_LIVE_MODEL?.trim() || d.liveModel,
    weeklyModel: env.OLLAMA_WEEKLY_MODEL?.trim() || d.weeklyModel,
    autoThreshold: numberFromEnv(env.AGENT_AUTO_THRESHOLD, d.autoThreshold),
    suggestThreshold: numberFromEnv(env.AGENT_SUGGEST_THRESHOLD, d.suggestThreshold),
    autoCreateTasks: booleanFromEnv(env.AGENT_AUTO_CREATE_TASKS, d.autoCreateTasks),
  }
}
