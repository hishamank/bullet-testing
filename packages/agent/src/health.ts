/**
 * checkOllamaHealth — a tiny, dependency-injected probe of the local Ollama server.
 *
 * Local-first apps fail in one boring way: the model server isn't running (or the configured
 * model was never pulled), so every extraction throws "fetch failed" the moment the worker
 * touches it. This plain function lets the server boot preflight, a tRPC health query, and the
 * web "model offline" banner all answer the same question — "can we actually extract right now?"
 * — without any of them reaching into the Ollama client directly. It NEVER throws: a down server
 * is a normal, reportable state, not an exception.
 */

import type { AgentDeps } from './deps'

/**
 * Normalize an Ollama model name for matching. Ollama treats a tagless name as the `:latest` tag
 * (`ollama pull gemma3` installs `gemma3:latest`, listed as `gemma3:latest`), so we canonicalize a
 * tagless name to `:latest` on BOTH sides before comparing. Then `OLLAMA_LIVE_MODEL=gemma3` matches
 * a listed `gemma3:latest`, while an explicit `gemma3:4b` still only matches `gemma3:4b`.
 */
function normalizeModelName(name: string): string {
  return name.includes(':') ? name : `${name}:latest`
}

/** A snapshot of whether the local model is reachable and the configured live model is present. */
export interface OllamaHealth {
  /** Did `listModels()` succeed (i.e. the server answered)? */
  reachable: boolean
  /** The model names the server reports (empty when unreachable). */
  models: string[]
  /** Whether `config.liveModel` is among `models` (tag-normalized: a tagless name implies `:latest`). */
  liveModelAvailable: boolean
  /** The configured live model, echoed back so callers can render "run `ollama pull <x>`". */
  liveModel: string
  /** The failure message when unreachable (absent on success). */
  error?: string
}

/**
 * Probe Ollama via `listModels()`. On throw (server down → `fetch failed`) → `reachable: false`
 * carrying the message. On success → the reported model names plus whether the configured live
 * model is one of them (Ollama returns names like `gemma3:4b`).
 */
export async function checkOllamaHealth(
  deps: Pick<AgentDeps, 'ollama' | 'config'>,
): Promise<OllamaHealth> {
  const { liveModel } = deps.config
  try {
    const models = (await deps.ollama.listModels()).map((m) => m.name)
    const wanted = normalizeModelName(liveModel)
    const liveModelAvailable = models.some((m) => normalizeModelName(m) === wanted)
    return { reachable: true, models, liveModelAvailable, liveModel }
  } catch (err) {
    return {
      reachable: false,
      models: [],
      liveModelAvailable: false,
      liveModel,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
