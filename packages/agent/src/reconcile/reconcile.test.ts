import {
  createBullet,
  createTestDb,
  createUser,
  type DbConnection,
  getActivityById,
  listSuggestionsByBullet,
  updateBullet,
} from '@bullet/db'
import { describe, expect, test } from 'vitest'
import { AGENT_CONFIG_DEFAULTS } from '../config'
import type { AgentDeps } from '../deps'
import { createAgentEmitter } from '../events'
import { createScriptedOllamaClient, type OllamaScript } from '../ollama/scripted'
import { enqueueExtraction } from '../queue/enqueue'
import { createExtractionWorker } from '../queue/worker'
import { reprocessBullet } from './reconcile'

function makeDeps(conn: DbConnection, script: OllamaScript): AgentDeps {
  return {
    db: conn.db,
    ollama: createScriptedOllamaClient(script),
    config: AGENT_CONFIG_DEFAULTS,
    emitter: createAgentEmitter(),
  }
}

/** The first element, asserting it exists (satisfies noUncheckedIndexedAccess). */
function head<T>(arr: T[]): T {
  const v = arr[0]
  if (v === undefined) throw new Error('expected a non-empty array')
  return v
}

describe('reprocessBullet (§4.7 reconciliation)', () => {
  test('keeps a matching applied entity, adds a new one, retires a removed one, regenerates pending', async () => {
    const conn = createTestDb()
    const user = createUser(conn.db, { name: 'U' })
    const bullet = createBullet(conn.db, { owner_id: user.id, text: 'buy milk and call mom' })

    // First analysis: two auto activities ("buy milk", "call mom") — actually tasks.
    const firstScript: OllamaScript = {
      chat: () =>
        JSON.stringify({
          candidates: [
            {
              kind: 'activity',
              orientation: 'happened',
              text: 'bought milk',
              fields: { name: 'bought milk' },
              confidence: 0.95,
            },
            {
              kind: 'activity',
              orientation: 'happened',
              text: 'called mom',
              fields: { name: 'called mom' },
              confidence: 0.95,
            },
          ],
        }),
    }
    const deps1 = makeDeps(conn, firstScript)
    enqueueExtraction(deps1, bullet.id, user.id)
    await createExtractionWorker(deps1).drain()

    const appliedSuggestions = listSuggestionsByBullet(conn.db, bullet.id)
    expect(appliedSuggestions).toHaveLength(2)
    // Both auto-applied → two activities exist.
    const accepted = appliedSuggestions.filter((s) => s.status === 'accepted')
    expect(accepted).toHaveLength(2)

    // Also leave a stale PENDING suggestion behind to prove it is retired.
    // (Re-extract via a lower-confidence path is unnecessary; we assert on regeneration below.)

    // Edit the bullet: "bought milk" stays, "called mom" is gone, "went running" is new.
    updateBullet(conn.db, bullet.id, { text: 'bought milk and went running' })

    const reconcileScript: OllamaScript = {
      chat: () =>
        JSON.stringify({
          candidates: [
            // Matches the kept entity (same kind + normalized name).
            {
              kind: 'activity',
              orientation: 'happened',
              text: 'bought milk',
              fields: { name: 'bought milk' },
              confidence: 0.95,
            },
            // New entity.
            {
              kind: 'activity',
              orientation: 'happened',
              text: 'went running',
              fields: { name: 'went running' },
              confidence: 0.95,
            },
          ],
        }),
    }
    const deps2 = makeDeps(conn, reconcileScript)
    const result = await reprocessBullet(deps2, bullet.id)

    // "bought milk" was KEPT (not duplicated).
    expect(result.keptEntityIds).toHaveLength(1)
    const keptActivity = getActivityById(conn.db, head(result.keptEntityIds))
    expect(keptActivity?.name).toBe('bought milk')
    expect(keptActivity?.state).toBe('active')

    // "went running" was ADDED as a new (auto-applied) suggestion.
    expect(result.newSuggestionIds).toHaveLength(1)
    expect(result.appliedIds).toHaveLength(1)

    // "called mom" was RETIRED (soft-deleted) — it matched no new candidate.
    expect(result.retiredEntityIds).toHaveLength(1)
    const retired = getActivityById(conn.db, head(result.retiredEntityIds))
    expect(retired?.name).toBe('called mom')
    expect(retired?.state).toBe('deleted')
  })

  test('retires still-pending stale suggestions before re-extracting', async () => {
    const conn = createTestDb()
    const user = createUser(conn.db, { name: 'U' })
    const bullet = createBullet(conn.db, { owner_id: user.id, text: 'plan a trip' })

    // First analysis: a suggest-tier task (pending, not applied).
    const deps1 = makeDeps(conn, {
      chat: () =>
        JSON.stringify({
          candidates: [
            {
              kind: 'task',
              orientation: 'future_oneoff',
              text: 'plan a trip',
              fields: { title: 'plan a trip' },
              confidence: 0.7,
            },
          ],
        }),
    })
    enqueueExtraction(deps1, bullet.id, user.id)
    await createExtractionWorker(deps1).drain()

    const before = listSuggestionsByBullet(conn.db, bullet.id)
    expect(before).toHaveLength(1)
    expect(head(before).status).toBe('pending')

    // Reprocess → the stale pending suggestion is rejected; a fresh one is produced.
    updateBullet(conn.db, bullet.id, { text: 'plan a holiday' })
    const deps2 = makeDeps(conn, {
      chat: () =>
        JSON.stringify({
          candidates: [
            {
              kind: 'task',
              orientation: 'future_oneoff',
              text: 'plan a holiday',
              fields: { title: 'plan a holiday' },
              confidence: 0.7,
            },
          ],
        }),
    })
    const result = await reprocessBullet(deps2, bullet.id)

    expect(result.retiredPendingIds).toEqual([head(before).id])
    // The old suggestion is now rejected.
    const all = listSuggestionsByBullet(conn.db, bullet.id)
    const old = all.find((s) => s.id === head(before).id)
    expect(old?.status).toBe('rejected')
    // A new pending suggestion exists.
    expect(result.newSuggestionIds).toHaveLength(1)
  })
})
