/**
 * The core loop, end-to-end, through the web's REAL tRPC client wiring.
 *
 * This is the highest-value web test: it proves capture → suggestion → accept → entity works using
 * the exact client the app builds (`createTRPCClient` + `httpBatchLink`), talking to an in-process
 * `@bullet/server` Hono app. Hono's `app.request(...)` returns a `Response`, so the batch link's
 * `fetch` calls the app directly — no socket, no live model (the Ollama client is scripted).
 *
 * It exercises the whole stack the way the browser would: the same typed `AppRouter` client, real
 * tRPC serialization over a real HTTP request/response, the real server router + apply engine + the
 * agent worker over a real (in-memory) SQLite db.
 */

import { AGENT_CONFIG_DEFAULTS, createScriptedOllamaClient, type OllamaScript } from '@bullet/agent'
import { createTestDb } from '@bullet/db'
import { type AppRouter, createApp, createServerDeps, type ServerDeps } from '@bullet/server'
import { createTRPCClient, httpBatchLink, type TRPCClient } from '@trpc/client'
import { describe, expect, test } from 'vitest'

interface Harness {
  deps: ServerDeps
  client: TRPCClient<AppRouter>
}

/** Build an in-process server over a fresh in-memory db + the given scripted model, and the real
 *  typed tRPC client wired to it through Hono's fetch-shaped `app.request`. */
function makeHarness(script: OllamaScript): Harness {
  const { db } = createTestDb()
  const ollama = createScriptedOllamaClient(script)
  const deps = createServerDeps({ db, ollama, config: AGENT_CONFIG_DEFAULTS })
  const app = createApp(deps)

  const client = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: 'http://localhost/trpc',
        // Hono's app.request(url, init) → Response: an async wrapper makes it the Promise<Response>
        // shape httpBatchLink's fetch wants, so the client talks to the in-process app with no socket.
        fetch: async (input, init) => app.request(String(input), init),
      }),
    ],
  })

  return { deps, client }
}

/** One future, one-off task candidate → tier 'suggest' → stays PENDING for explicit accept. */
function taskScript(): OllamaScript {
  return {
    chat: () =>
      JSON.stringify({
        candidates: [
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

/** One high-confidence happened activity → tier 'auto' → auto-applied with no accept step. */
function activityScript(): OllamaScript {
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
        ],
      }),
  }
}

describe('core loop through the web tRPC client', () => {
  test('capture a bullet → suggestion appears → accept → task entity exists', async () => {
    const { deps, client } = makeHarness(taskScript())

    // 1) Capture: the bullet exists and round-trips through the real client.
    const bullet = await client.bullets.create.mutate({ text: 'remember to call the dentist' })
    expect(bullet.id).toBeTruthy()
    expect(bullet.text).toBe('remember to call the dentist')

    // No task yet, nothing pending — extraction is queued, not yet run.
    expect(await client.tasks.list.query()).toHaveLength(0)
    expect(await client.suggestions.listPending.query()).toHaveLength(0)

    // 2) Process the queued extraction job (scripted model returns instantly).
    expect(await deps.runtime.worker.drain()).toBe(1)

    // 3) The task SUGGESTION now appears: pending, kind 'task', traced to the bullet.
    const pending = await client.suggestions.listPending.query()
    expect(pending).toHaveLength(1)
    const suggestion = pending[0]
    if (!suggestion) throw new Error('expected a pending task suggestion')
    expect(suggestion.target_kind).toBe('task')
    expect(suggestion.status).toBe('pending')
    expect(suggestion.source_bullet_id).toBe(bullet.id)
    // A task suggestion is never auto-applied → no entity exists yet.
    expect(await client.tasks.list.query()).toHaveLength(0)

    // 4) Accept it through the client.
    const accepted = await client.suggestions.accept.mutate({ id: suggestion.id })
    expect(accepted.suggestion.status).toBe('accepted')

    // 5) The task ENTITY now exists with the expected title + provenance…
    const tasks = await client.tasks.list.query()
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.title).toBe('call the dentist')
    expect(tasks[0]?.source_bullet_id).toBe(bullet.id)

    // …and the accepted suggestion is gone from the pending list.
    expect(await client.suggestions.listPending.query()).toHaveLength(0)
  })

  test('a high-confidence record auto-applies — entity appears with no accept step', async () => {
    const { deps, client } = makeHarness(activityScript())

    const bullet = await client.bullets.create.mutate({ text: 'ran 5k this morning' })
    expect(await deps.runtime.worker.drain()).toBe(1)

    // The activity was auto-applied by the worker (tier 'auto'): a real entity, never pending.
    const activities = await client.activities.list.query()
    expect(activities).toHaveLength(1)
    expect(activities[0]?.name).toBe('ran 5k')
    expect(activities[0]?.source_bullet_id).toBe(bullet.id)
    expect(await client.suggestions.listPending.query()).toHaveLength(0)
  })
})
