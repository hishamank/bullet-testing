/**
 * Shared test scaffolding — builds the singleton deps over an in-memory db + a scripted Ollama
 * client (no live model, no socket). NOT exported from the package barrel; tests import it
 * directly. The `.ts` suffix-less import keeps it out of the build entry (only `src/index.ts` is).
 */

import {
  AGENT_CONFIG_DEFAULTS,
  type AgentConfig,
  createScriptedOllamaClient,
  type OllamaScript,
} from '@bullet/agent'
import { createTestDb } from '@bullet/db'
import { createServerDeps, type ServerDeps } from './context'

/** Build server deps over a fresh in-memory db and a scripted Ollama client. */
export function buildTestDeps(
  script: OllamaScript = {},
  config: AgentConfig = AGENT_CONFIG_DEFAULTS,
): ServerDeps {
  const { db, sqlite } = createTestDb()
  const ollama = createScriptedOllamaClient(script)
  // Thread the raw handle through so a test exercising the standalone shutdown path can assert the
  // db is actually closed by `stop()` (the real server keeps it for the same reason).
  return createServerDeps({ db, ollama, config, sqlite })
}

/**
 * A canned extraction response: one `happened` activity (high confidence → tier 'auto', the
 * worker auto-applies it) plus one `future_oneoff` task (tasks are never auto-applied with the
 * default config → stays pending for review).
 */
export function activityPlusTaskScript(): OllamaScript {
  return {
    chat: () =>
      JSON.stringify({
        candidates: [
          {
            kind: 'activity',
            orientation: 'happened',
            text: 'ran 5k',
            fields: { name: 'ran 5k' },
            confidence: 0.96,
          },
          {
            kind: 'task',
            orientation: 'future_oneoff',
            text: 'call the dentist',
            fields: { title: 'call the dentist' },
            confidence: 0.9,
          },
        ],
      }),
  }
}

/** Serialise an extraction candidate list into the model's JSON envelope. */
function candidatesResponse(candidates: Record<string, unknown>[]): string {
  return JSON.stringify({ candidates })
}

/**
 * A TWO-response chat QUEUE driving a create-then-edit reconcile (§4.7) on a SINGLE client (the
 * same runtime serves `bullets.create`'s extraction and `bullets.update`'s reprocess, so the two
 * passes must be consumed FIFO from one scripted client).
 *
 * Pass 1 (initial extraction): auto activity "ran 5k" (tier 'auto' → auto-applied) + suggest task
 * "call the dentist" (pending).
 * Pass 2 (reprocess after edit): "ran 5k" survives (matches the applied activity → KEPT, unchanged)
 * while "call the dentist" is dropped (its pending suggestion is RETIRED) and a new auto activity
 * "swam 1k" appears (a NEW suggestion, auto-applied). Proves reconciliation rather than blind
 * recreation: the matched entity keeps its id, the removed candidate is retired, the new one added.
 */
export function reconcileScript(): OllamaScript {
  return {
    chatQueue: [
      candidatesResponse([
        {
          kind: 'activity',
          orientation: 'happened',
          text: 'ran 5k',
          fields: { name: 'ran 5k' },
          confidence: 0.96,
        },
        {
          kind: 'task',
          orientation: 'future_oneoff',
          text: 'call the dentist',
          fields: { title: 'call the dentist' },
          confidence: 0.9,
        },
      ]),
      candidatesResponse([
        {
          kind: 'activity',
          orientation: 'happened',
          text: 'ran 5k',
          fields: { name: 'ran 5k' },
          confidence: 0.96,
        },
        {
          kind: 'activity',
          orientation: 'happened',
          text: 'swam 1k',
          fields: { name: 'swam 1k' },
          confidence: 0.96,
        },
      ]),
    ],
  }
}
