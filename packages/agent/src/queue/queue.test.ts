import {
  createBullet,
  createTask,
  createTestDb,
  createTracker,
  createUser,
  type DbConnection,
  getJobById,
  getTaskById,
  listActivities,
  listSuggestionsByBullet,
  listTasks,
  listTrackerEntries,
} from '@bullet/db'
import { describe, expect, test } from 'vitest'
import { AGENT_CONFIG_DEFAULTS } from '../config'
import type { AgentDeps } from '../deps'
import { type AgentEmitter, createAgentEmitter, type ExtractionCompleteEvent } from '../events'
import { createScriptedOllamaClient, type OllamaScript } from '../ollama/scripted'
import { enqueueExtraction } from './enqueue'
import { createExtractionWorker } from './worker'

/** Build deps over a fresh in-memory db + a scripted Ollama client. */
function makeDeps(conn: DbConnection, script: OllamaScript, emitter?: AgentEmitter): AgentDeps {
  return {
    db: conn.db,
    ollama: createScriptedOllamaClient(script),
    config: AGENT_CONFIG_DEFAULTS,
    emitter: emitter ?? createAgentEmitter(),
  }
}

describe('queue end-to-end', () => {
  test('drains an extract_bullet job: persists suggestions w/ provenance, auto-applies, emits complete', async () => {
    const conn = createTestDb()
    const user = createUser(conn.db, { name: 'U' })
    const bullet = createBullet(conn.db, { owner_id: user.id, text: 'ran 5k this morning' })

    const emitter = createAgentEmitter()
    const completed: ExtractionCompleteEvent[] = []
    emitter.on('extraction:complete', (e) => completed.push(e))

    // A high-confidence 'happened' activity → an auto record.
    const deps = makeDeps(
      conn,
      {
        chat: () =>
          JSON.stringify({
            candidates: [
              {
                kind: 'activity',
                orientation: 'happened',
                text: 'ran 5k this morning',
                fields: { name: 'ran 5k' },
                confidence: 0.95,
              },
            ],
          }),
      },
      emitter,
    )

    const job = enqueueExtraction(deps, bullet.id, user.id)
    const worker = createExtractionWorker(deps)
    const processed = await worker.drain()
    expect(processed).toBe(1)

    // The job is done.
    expect(getJobById(conn.db, job.id)?.status).toBe('done')

    // A suggestion was persisted with correct provenance.
    const suggestions = listSuggestionsByBullet(conn.db, bullet.id)
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]?.owner_id).toBe(user.id)
    expect(suggestions[0]?.source_bullet_id).toBe(bullet.id)
    expect(suggestions[0]?.tier).toBe('auto')
    // Auto suggestion was applied (status accepted).
    expect(suggestions[0]?.status).toBe('accepted')

    // The real entity exists in the db.
    const activities = listActivities(conn.db, user.id)
    expect(activities).toHaveLength(1)
    expect(activities[0]?.name).toBe('ran 5k')
    expect(activities[0]?.source_bullet_id).toBe(bullet.id)

    // The completion event fired with the ids.
    expect(completed).toHaveLength(1)
    expect(completed[0]?.jobId).toBe(job.id)
    expect(completed[0]?.bulletId).toBe(bullet.id)
    expect(completed[0]?.suggestionIds).toEqual([suggestions[0]?.id])
    expect(completed[0]?.appliedIds).toEqual([suggestions[0]?.id])
  })

  test('auto-applies a tracker_entry append when a tracker matches', async () => {
    const conn = createTestDb()
    const user = createUser(conn.db, { name: 'U' })
    const seedBullet = createBullet(conn.db, { owner_id: user.id, text: 'seed' })
    createTracker(conn.db, {
      owner_id: user.id,
      source_bullet_id: seedBullet.id,
      name: 'mood',
      input_type: 'scale',
      config: { input_type: 'scale', min: 1, max: 5 },
    })
    const bullet = createBullet(conn.db, { owner_id: user.id, text: 'mood was 4' })

    const deps = makeDeps(conn, {
      chat: () =>
        JSON.stringify({
          candidates: [
            {
              kind: 'tracker_entry',
              orientation: 'happened',
              text: 'mood was 4',
              referenceName: 'mood',
              fields: { value: 4 },
              confidence: 0.95,
            },
          ],
        }),
    })

    enqueueExtraction(deps, bullet.id, user.id)
    await createExtractionWorker(deps).drain()

    const entries = listTrackerEntries(conn.db, user.id)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.value).toBe(4)
    expect(entries[0]?.source_bullet_id).toBe(bullet.id)
  })

  test('auto-applies a mark-done UPDATE: flips the matched open task to done (same row)', async () => {
    const conn = createTestDb()
    const user = createUser(conn.db, { name: 'U' })
    const seedBullet = createBullet(conn.db, { owner_id: user.id, text: 'seed' })
    const task = createTask(conn.db, {
      owner_id: user.id,
      source_bullet_id: seedBullet.id,
      title: 'call the dentist',
      notes: 'before noon',
      due_at: 1_700_000_000_000,
      priority: 'P2',
    })
    const bullet = createBullet(conn.db, { owner_id: user.id, text: 'called the dentist' })

    const deps = makeDeps(conn, {
      chat: () =>
        JSON.stringify({
          candidates: [
            {
              kind: 'activity',
              orientation: 'happened',
              text: 'called the dentist',
              referenceName: 'call the dentist',
              fields: {},
              confidence: 0.95,
            },
          ],
        }),
    })

    enqueueExtraction(deps, bullet.id, user.id)
    await createExtractionWorker(deps).drain()

    // The suggestion is an auto task UPDATE that actually applied (status accepted).
    const suggestions = listSuggestionsByBullet(conn.db, bullet.id)
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]?.target_kind).toBe('task')
    expect(suggestions[0]?.operation).toBe('update')
    expect(suggestions[0]?.tier).toBe('auto')
    expect(suggestions[0]?.status).toBe('accepted')

    // The SAME task row is now done — no duplicate task was minted; other fields preserved.
    const after = getTaskById(conn.db, task.id)
    expect(after?.status).toBe('done')
    expect(after?.title).toBe('call the dentist')
    expect(after?.notes).toBe('before noon')
    expect(listTasks(conn.db, user.id)).toHaveLength(1)
  })

  test('does NOT auto-apply a suggest-tier suggestion (lower confidence)', async () => {
    const conn = createTestDb()
    const user = createUser(conn.db, { name: 'U' })
    const bullet = createBullet(conn.db, { owner_id: user.id, text: 'maybe ran' })

    const deps = makeDeps(conn, {
      chat: () =>
        JSON.stringify({
          candidates: [
            {
              kind: 'activity',
              orientation: 'happened',
              text: 'maybe ran',
              fields: { name: 'ran' },
              confidence: 0.6, // between suggest (0.5) and auto (0.85)
            },
          ],
        }),
    })

    enqueueExtraction(deps, bullet.id, user.id)
    await createExtractionWorker(deps).drain()

    const suggestions = listSuggestionsByBullet(conn.db, bullet.id)
    expect(suggestions[0]?.tier).toBe('suggest')
    expect(suggestions[0]?.status).toBe('pending')
    // No activity was created (not auto-applied).
    expect(listActivities(conn.db, user.id)).toHaveLength(0)
  })

  test('failure path: a job whose bullet is missing → markJobFailed + extraction:error, loop survives', async () => {
    const conn = createTestDb()
    const user = createUser(conn.db, { name: 'U' })
    const realBullet = createBullet(conn.db, { owner_id: user.id, text: 'real one' })

    const emitter = createAgentEmitter()
    const errors: { jobId: string; bulletId: string | null; error: string }[] = []
    emitter.on('extraction:error', (e) => errors.push(e))
    const completed: ExtractionCompleteEvent[] = []
    emitter.on('extraction:complete', (e) => completed.push(e))

    const deps = makeDeps(
      conn,
      {
        chat: () =>
          JSON.stringify({
            candidates: [
              {
                kind: 'activity',
                orientation: 'happened',
                text: 'real one',
                fields: { name: 'real' },
                confidence: 0.9,
              },
            ],
          }),
      },
      emitter,
    )

    // First a job pointing at a non-existent bullet, then a valid job — the loop must survive.
    const badJob = enqueueExtraction(deps, 'de305d54-75b4-431b-adb2-eb6b9e546014', user.id)
    enqueueExtraction(deps, realBullet.id, user.id)

    const worker = createExtractionWorker(deps)
    const processed = await worker.drain()
    expect(processed).toBe(2)

    // The bad job failed and emitted an error.
    expect(getJobById(conn.db, badJob.id)?.status).toBe('failed')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.jobId).toBe(badJob.id)

    // The loop survived and processed the valid job too.
    expect(completed).toHaveLength(1)
    expect(completed[0]?.bulletId).toBe(realBullet.id)
  })
})

describe('worker start/stop', () => {
  test('start polls and processes queued jobs, then stop halts the loop', async () => {
    const conn = createTestDb()
    const user = createUser(conn.db, { name: 'U' })
    const bullet = createBullet(conn.db, { owner_id: user.id, text: 'ran' })

    const deps = makeDeps(conn, {
      chat: () =>
        JSON.stringify({
          candidates: [
            {
              kind: 'activity',
              orientation: 'happened',
              text: 'ran',
              fields: { name: 'ran' },
              confidence: 0.95,
            },
          ],
        }),
    })

    enqueueExtraction(deps, bullet.id, user.id)
    const worker = createExtractionWorker(deps)
    worker.start(5)
    expect(worker.running).toBe(true)

    // Poll until the job is processed.
    await viWaitFor(() => listSuggestionsByBullet(conn.db, bullet.id).length === 1)
    worker.stop()
    expect(worker.running).toBe(false)
    expect(listSuggestionsByBullet(conn.db, bullet.id)).toHaveLength(1)
  })
})

/** A tiny poll-until helper (avoids depending on a fake timer for the interval loop). */
async function viWaitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('viWaitFor timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}
