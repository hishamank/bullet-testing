import { createScriptedLlmClient, EngineError } from '@bullet/engine'
import { eq } from 'drizzle-orm'
import { describe, expect, test } from 'vite-plus/test'
import { activities, bullets, events, jobs, suggestions } from '../db/schema'
import { candidate, createHarness, llmByText, T0, uid } from '../test/helpers'
import { claimNextJob, DEFAULT_RETRY_POLICY, recoverStuckJobs, retryDelay } from './jobs'

const bulletRow = (h: ReturnType<typeof createHarness>, id: string) => {
  const b = h.db.select().from(bullets).where(eq(bullets.id, id)).get()
  if (!b) throw new Error('no bullet')
  return b
}

describe('processing (scripted model, never live)', () => {
  test('a capture is extracted: value-less activity auto-applies, the event waits → needs_review', async () => {
    const llm = llmByText({
      'ran 5k': [
        candidate({ text: 'ran 5k', fields: { name: 'ran 5k' }, confidence: 0.95 }),
        candidate({
          kind: 'event',
          orientation: 'future_oneoff',
          text: 'dentist thursday 3pm',
          fields: { title: 'dentist', when: 'thursday 3pm' },
        }),
      ],
    })
    const h = createHarness(llm)
    const id = await h.capture('ran 5k, dentist thursday 3pm')
    expect(await h.worker.drain()).toBe(1)

    const b = bulletRow(h, id)
    expect(b.proc_status).toBe('needs_review')
    expect(b.proc_attempts).toBe(1)

    const [activity] = h.db.select().from(activities).all()
    expect(activity).toMatchObject({ name: 'ran 5k', occurred_at: T0, source_bullet_id: id })
    expect(h.db.select().from(events).all()).toHaveLength(0) // waits for review

    const pulled = await h.pull()
    expect(pulled.changes.activities).toHaveLength(1)
    const event = pulled.changes.suggestions.find((s) => s.target_kind === 'event')
    expect(event).toMatchObject({ status: 'pending', tier: 'suggest' })
    expect(event?.payload.starts_at).toBe(Date.UTC(2026, 9, 15, 13)) // 15:00 Paris
    const auto = pulled.changes.suggestions.find((s) => s.target_kind === 'activity')
    expect(auto).toMatchObject({
      status: 'accepted',
      auto_applied: true,
      applied_entity_id: activity?.id,
    })
  })

  test('nothing to extract → processed', async () => {
    const h = createHarness(llmByText({}))
    const id = await h.capture('just a thought')
    await h.worker.drain()
    expect(bulletRow(h, id).proc_status).toBe('processed')
  })

  test('the prompt carries the capture time and zone', async () => {
    const llm = llmByText({})
    const h = createHarness(llm)
    await h.capture('x', { timezone: 'America/New_York' })
    await h.worker.drain()
    expect(llm.chatCalls[0]?.messages[1]?.content).toContain(
      'Written on Thursday 2026-10-15 03:12 (time zone America/New_York).',
    )
  })
})

describe('failure, retry and backoff', () => {
  const failing = () =>
    createScriptedLlmClient({
      chat: () => {
        throw new EngineError('LLM_HTTP', 'connection refused')
      },
    })

  test('a transient failure schedules a retry: synced + error + next_retry_at', async () => {
    const h = createHarness(failing())
    const id = await h.capture('x')
    await h.worker.drain()
    const b = bulletRow(h, id)
    expect(b).toMatchObject({
      proc_status: 'synced',
      proc_attempts: 1,
      proc_error_code: 'llm_unavailable',
      proc_next_retry_at: T0 + retryDelay(1, DEFAULT_RETRY_POLICY),
    })
    // Not due yet: nothing runs.
    expect(await h.worker.drain()).toBe(0)
  })

  test('after maxAttempts the bullet is failed (distinguishable from success)', async () => {
    const h = createHarness(failing())
    const id = await h.capture('x')
    for (let i = 0; i < DEFAULT_RETRY_POLICY.maxAttempts; i++) {
      await h.worker.drain()
      h.clock.now += DEFAULT_RETRY_POLICY.maxDelayMs
    }
    const b = bulletRow(h, id)
    expect(b).toMatchObject({
      proc_status: 'failed',
      proc_attempts: DEFAULT_RETRY_POLICY.maxAttempts,
      proc_error_code: 'llm_unavailable',
      proc_next_retry_at: null,
    })
    expect(h.db.select().from(jobs).get()?.status).toBe('failed')

    const pulled = await h.pull()
    expect(pulled.changes.bullets[0]?.processing).toMatchObject({
      status: 'failed',
      attempts: DEFAULT_RETRY_POLICY.maxAttempts,
      error: { code: 'llm_unavailable' },
    })
  })

  test('a user retry re-queues a failed bullet, and it can then succeed', async () => {
    let up = false
    const llm = createScriptedLlmClient({
      chat: () => {
        if (!up) throw new EngineError('LLM_HTTP', 'down')
        return '{"candidates":[]}'
      },
    })
    const h = createHarness(llm, { retry: { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 } })
    const id = await h.capture('x')
    await h.worker.drain()
    expect(bulletRow(h, id).proc_status).toBe('failed')

    up = true
    const res = await h.push([{ op_id: uid(), type: 'bullet.retry', bullet_id: id }])
    expect(res.results[0]?.status).toBe('applied')
    expect(bulletRow(h, id).proc_status).toBe('synced')
    await h.worker.drain()
    expect(bulletRow(h, id)).toMatchObject({
      proc_status: 'processed',
      proc_attempts: 2,
      proc_error_code: null,
    })
  })

  test('a hung model times out (llm_timeout) instead of wedging the queue', async () => {
    const hung = { chat: () => new Promise<never>(() => {}) }
    const h = createHarness(hung, { llmTimeoutMs: 20 })
    const id = await h.capture('x')
    await h.worker.drain()
    expect(bulletRow(h, id)).toMatchObject({
      proc_status: 'synced',
      proc_error_code: 'llm_timeout',
    })
  })

  test('garbage from the model (after the repair retry) is llm_bad_output', async () => {
    const h = createHarness(createScriptedLlmClient({ chat: () => 'not json' }))
    const id = await h.capture('x')
    await h.worker.drain()
    expect(bulletRow(h, id).proc_error_code).toBe('llm_bad_output')
  })
})

describe('durability', () => {
  test('jobs left running by a crash are recovered at startup', async () => {
    const h = createHarness()
    const id = await h.capture('x')
    // Simulate a crash mid-call: claimed, never completed.
    expect(claimNextJob(h.db, h.clock.now)).not.toBeNull()
    expect(bulletRow(h, id).proc_status).toBe('processing')

    expect(recoverStuckJobs(h.db, h.clock.now)).toBe(1)
    expect(bulletRow(h, id)).toMatchObject({ proc_status: 'synced', proc_error_code: 'internal' })
    expect(h.db.select().from(jobs).get()?.status).toBe('queued')
    await h.worker.drain()
    expect(bulletRow(h, id).proc_status).toBe('processed')
  })

  test('an edit while the model is thinking discards the stale result', async () => {
    let release: () => void = () => {}
    let calls = 0
    const llm = createScriptedLlmClient({
      chat: async (req) => {
        calls += 1
        if (calls === 1) await new Promise<void>((r) => (release = r))
        const user = req.messages[1]?.content ?? ''
        return JSON.stringify({
          candidates: [
            candidate({ fields: { name: user.includes('v2') ? 'v2 thing' : 'v1 thing' } }),
          ],
        })
      },
    })
    const h = createHarness(llm)
    const id = await h.capture('v1')
    const running = h.worker.drain()
    await new Promise((r) => setTimeout(r, 0))
    await h.push([
      { op_id: uid(), type: 'bullet.edit', bullet_id: id, text: 'v2', edited_at: T0 + 1 },
    ])
    release()
    await running
    await h.worker.drain()
    const names = h.db
      .select()
      .from(activities)
      .all()
      .map((a) => a.name)
    expect(names).toEqual(['v2 thing'])
    expect(h.db.select().from(suggestions).all()).toHaveLength(1)
  })

  test('a deleted bullet is not processed', async () => {
    const llm = llmByText({ x: [candidate({ fields: { name: 'x' } })] })
    const h = createHarness(llm)
    const id = await h.capture('x')
    await h.push([{ op_id: uid(), type: 'bullet.delete', bullet_id: id, mode: 'cascade' }])
    expect(await h.worker.drain()).toBe(0)
    expect(llm.chatCalls).toHaveLength(0)
  })
})
