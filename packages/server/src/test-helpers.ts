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
  const { db } = createTestDb()
  const ollama = createScriptedOllamaClient(script)
  return createServerDeps({ db, ollama, config })
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
