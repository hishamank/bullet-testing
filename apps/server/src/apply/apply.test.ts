import { eq } from 'drizzle-orm'
import { describe, expect, test } from 'vite-plus/test'
import { activities, bullets, events, suggestions, tasks, trackerEntries } from '../db/schema'
import { candidate, createHarness, llmByText, T0, uid } from '../test/helpers'
import { applySuggestion, getSuggestion } from './apply'
import { insertEntity, patchEntity } from './entities'

type H = ReturnType<typeof createHarness>

const byText = (a: string, b: string) => a.localeCompare(b)

const suggestionsOf = (h: H, bulletId: string) =>
  h.db.select().from(suggestions).where(eq(suggestions.source_bullet_id, bulletId)).all()

const op = <T extends object>(o: T) => ({ op_id: uid(), ...o })

/** Seed an open task the user created by hand. */
function seedTask(h: H, title: string) {
  const id = uid()
  insertEntity(
    h.db,
    'task',
    {
      id,
      owner_id: h.ownerId,
      source_bullet_id: null,
      status: 'todo',
      title,
      notes: null,
      due_at: null,
      priority: null,
    },
    h.clock.now,
  )
  return id
}

describe('accept / reject', () => {
  test('accept applies with apply-time revalidation; the entity id is the suggestion id', async () => {
    const llm = llmByText({
      dentist: [
        candidate({
          kind: 'event',
          orientation: 'future_oneoff',
          fields: { title: 'dentist', when: 'friday 3pm' },
        }),
      ],
    })
    const h = createHarness(llm)
    const b = await h.capture('dentist friday 3pm')
    await h.worker.drain()
    const [s] = suggestionsOf(h, b)
    const res = await h.push([op({ type: 'suggestion.accept', suggestion_id: s?.id ?? '' })])
    expect(res.results[0]?.status).toBe('applied')

    const [event] = h.db.select().from(events).all()
    expect(event).toMatchObject({
      id: s?.id,
      title: 'dentist',
      all_day: false,
      source_bullet_id: b,
    })
    expect(getSuggestion(h.db, h.ownerId, s?.id ?? '')).toMatchObject({
      status: 'accepted',
      applied_entity_id: s?.id,
      auto_applied: false,
    })
    // The last pending suggestion resolved → the bullet is processed.
    expect(h.db.select().from(bullets).get()?.proc_status).toBe('processed')
  })

  test('applying twice never duplicates (idempotent apply)', async () => {
    const h = createHarness(
      llmByText({
        milk: [
          candidate({ kind: 'task', orientation: 'future_oneoff', fields: { title: 'buy milk' } }),
        ],
      }),
    )
    const b = await h.capture('buy milk')
    await h.worker.drain()
    const [s] = suggestionsOf(h, b)
    if (!s) throw new Error('no suggestion')
    const once = applySuggestion(h.db, s, h.clock.now)
    const twice = applySuggestion(h.db, once, h.clock.now)
    expect(twice.applied_entity_id).toBe(once.applied_entity_id)
    expect(h.db.select().from(tasks).all()).toHaveLength(1)
    // A second accept (say from another device) is a duplicate, still without duplicating data.
    const res = await h.push([op({ type: 'suggestion.accept', suggestion_id: s.id })])
    expect(res.results[0]?.status).toBe('duplicate')
    expect(h.db.select().from(tasks).all()).toHaveLength(1)
  })

  test('accept with edits → status edited, edited payload applied', async () => {
    const h = createHarness(
      llmByText({
        milk: [
          candidate({ kind: 'task', orientation: 'future_oneoff', fields: { title: 'buy milk' } }),
        ],
      }),
    )
    const b = await h.capture('buy milk')
    await h.worker.drain()
    const [s] = suggestionsOf(h, b)
    await h.push([
      op({
        type: 'suggestion.accept',
        suggestion_id: s?.id ?? '',
        payload: { ...s?.payload, title: 'buy oat milk', priority: 'P2' },
      }),
    ])
    expect(h.db.select().from(tasks).get()).toMatchObject({ title: 'buy oat milk', priority: 'P2' })
    expect(getSuggestion(h.db, h.ownerId, s?.id ?? '')?.status).toBe('edited')
  })

  test('an edited payload that fails validation is refused and changes nothing', async () => {
    const h = createHarness(
      llmByText({
        milk: [
          candidate({ kind: 'task', orientation: 'future_oneoff', fields: { title: 'buy milk' } }),
        ],
      }),
    )
    const b = await h.capture('buy milk')
    await h.worker.drain()
    const [s] = suggestionsOf(h, b)
    const res = await h.push([
      op({
        type: 'suggestion.accept',
        suggestion_id: s?.id ?? '',
        payload: { ...s?.payload, title: '' },
      }),
    ])
    expect(res.results[0]).toMatchObject({ status: 'rejected', error: { code: 'invalid' } })
    expect(h.db.select().from(tasks).all()).toHaveLength(0)
    expect(getSuggestion(h.db, h.ownerId, s?.id ?? '')?.status).toBe('pending')
  })

  test('reject → rejected, bullet processed', async () => {
    const h = createHarness(
      llmByText({
        milk: [
          candidate({ kind: 'task', orientation: 'future_oneoff', fields: { title: 'buy milk' } }),
        ],
      }),
    )
    const b = await h.capture('buy milk')
    await h.worker.drain()
    const [s] = suggestionsOf(h, b)
    await h.push([op({ type: 'suggestion.reject', suggestion_id: s?.id ?? '' })])
    expect(getSuggestion(h.db, h.ownerId, s?.id ?? '')?.status).toBe('rejected')
    expect(h.db.select().from(bullets).get()?.proc_status).toBe('processed')
  })
})

describe('mark-done: field-level update, revalidated at apply time', () => {
  const doneLlm = () =>
    llmByText({
      called: [
        candidate({
          text: 'called the plumber',
          referenceName: 'call the plumber',
          confidence: 0.99,
        }),
      ],
    })

  test('only status is written: a title the user changed after extraction survives', async () => {
    const h = createHarness(doneLlm())
    const task = seedTask(h, 'call the plumber about the leak')
    const b = await h.capture('called the plumber')
    await h.worker.drain()
    const [s] = suggestionsOf(h, b)
    expect(s).toMatchObject({
      operation: 'update',
      target_id: task,
      payload: { status: 'done' },
      tier: 'suggest',
    })

    h.clock.now += 1000
    patchEntity(
      h.db,
      'task',
      h.ownerId,
      task,
      { title: 'call plumber (urgent)', priority: 'P1' },
      h.clock.now,
    )
    await h.push([op({ type: 'suggestion.accept', suggestion_id: s?.id ?? '' })])
    expect(h.db.select().from(tasks).get()).toMatchObject({
      status: 'done',
      title: 'call plumber (urgent)',
      priority: 'P1',
    })
  })

  test('a task completed or deleted in the meantime is not touched (conflict)', async () => {
    const h = createHarness(doneLlm())
    const task = seedTask(h, 'call the plumber about the leak')
    const b = await h.capture('called the plumber')
    await h.worker.drain()
    const [s] = suggestionsOf(h, b)
    patchEntity(h.db, 'task', h.ownerId, task, { status: 'cancelled' }, h.clock.now)
    const res = await h.push([op({ type: 'suggestion.accept', suggestion_id: s?.id ?? '' })])
    expect(res.results[0]).toMatchObject({ status: 'rejected', error: { code: 'conflict' } })
    expect(h.db.select().from(tasks).get()?.status).toBe('cancelled')
  })

  test('an exact match auto-applies and can be undone (status restored)', async () => {
    const h = createHarness(
      llmByText({
        'call mom': [candidate({ text: 'call mom', referenceName: 'call mom', confidence: 0.95 })],
      }),
    )
    const task = seedTask(h, 'call mom')
    const b = await h.capture('call mom — done')
    await h.worker.drain()
    const [s] = suggestionsOf(h, b)
    expect(s).toMatchObject({ status: 'accepted', auto_applied: true, applied_entity_id: task })
    expect(h.db.select().from(tasks).get()?.status).toBe('done')

    await h.push([op({ type: 'suggestion.undo', suggestion_id: s?.id ?? '' })])
    expect(h.db.select().from(tasks).get()?.status).toBe('todo')
    expect(getSuggestion(h.db, h.ownerId, s?.id ?? '')).toMatchObject({
      status: 'rejected',
      applied_entity_id: null,
    })
  })
})

describe('undo of auto-applied items', () => {
  const walk = () =>
    llmByText({ walk: [candidate({ fields: { name: 'walk' }, confidence: 0.95 })] })

  test('undo soft-deletes what was created', async () => {
    const h = createHarness(walk())
    const b = await h.capture('went for a walk')
    await h.worker.drain()
    const [s] = suggestionsOf(h, b)
    expect(s?.auto_applied).toBe(true)
    h.clock.now += 1000
    const res = await h.push([op({ type: 'suggestion.undo', suggestion_id: s?.id ?? '' })])
    expect(res.results[0]?.status).toBe('applied')
    expect(h.db.select().from(activities).get()?.state).toBe('deleted')
    // …and it shows up in the next pull.
    const pulled = await h.pull()
    expect(pulled.changes.activities[0]?.state).toBe('deleted')
  })

  test('undo is refused when the user edited the result since', async () => {
    const h = createHarness(walk())
    const b = await h.capture('went for a walk')
    await h.worker.drain()
    const [s] = suggestionsOf(h, b)
    h.clock.now += 1000
    patchEntity(
      h.db,
      'activity',
      h.ownerId,
      s?.applied_entity_id ?? '',
      { notes: 'lovely' },
      h.clock.now,
    )
    const res = await h.push([op({ type: 'suggestion.undo', suggestion_id: s?.id ?? '' })])
    expect(res.results[0]).toMatchObject({ status: 'rejected', error: { code: 'conflict' } })
    expect(h.db.select().from(activities).get()?.state).toBe('active')
  })
})

describe('tracker entries', () => {
  test('appending to a deleted tracker is refused at apply time', async () => {
    const h = createHarness(
      llmByText({
        mood: [candidate({ kind: 'tracker_entry', referenceName: 'mood', fields: { value: 4 } })],
      }),
    )
    const tracker = uid()
    insertEntity(
      h.db,
      'tracker',
      {
        id: tracker,
        owner_id: h.ownerId,
        source_bullet_id: null,
        name: 'mood',
        input_type: 'scale',
        config: { input_type: 'scale', min: 1, max: 5 },
      },
      h.clock.now,
    )
    const b = await h.capture('mood 4')
    await h.worker.drain()
    const [s] = suggestionsOf(h, b)
    expect(s).toMatchObject({ target_kind: 'tracker_entry', target_id: tracker, tier: 'suggest' })
    patchEntity(h.db, 'tracker', h.ownerId, tracker, { state: 'deleted' }, h.clock.now)
    const res = await h.push([op({ type: 'suggestion.accept', suggestion_id: s?.id ?? '' })])
    expect(res.results[0]).toMatchObject({ status: 'rejected', error: { code: 'conflict' } })
    expect(h.db.select().from(trackerEntries).all()).toHaveLength(0)
  })
})

describe('edit reconciles; delete offers cascade vs keep', () => {
  test('edit keeps the accepted task, retires what disappeared, adds what is new', async () => {
    const llm = llmByText({
      'v2:': [
        candidate({ kind: 'task', orientation: 'future_oneoff', fields: { title: 'buy milk' } }),
        candidate({ kind: 'task', orientation: 'future_oneoff', fields: { title: 'buy bread' } }),
      ],
      'v1:': [
        candidate({ kind: 'task', orientation: 'future_oneoff', fields: { title: 'buy milk' } }),
        candidate({ fields: { name: 'walk' }, confidence: 0.95 }),
      ],
    })
    const h = createHarness(llm)
    const b = await h.capture('v1: buy milk, went for a walk')
    await h.worker.drain()
    const milk = suggestionsOf(h, b).find((s) => s.target_kind === 'task')
    await h.push([op({ type: 'suggestion.accept', suggestion_id: milk?.id ?? '' })])

    h.clock.now += 1000
    await h.push([
      op({
        type: 'bullet.edit',
        bullet_id: b,
        text: 'v2: buy milk and bread',
        edited_at: T0 + 1000,
      }),
    ])
    await h.worker.drain()

    const live = suggestionsOf(h, b).filter((s) => s.state === 'active')
    expect(live.map((s) => String(s.payload.title ?? s.payload.name)).sort(byText)).toEqual([
      'buy bread',
      'buy milk',
    ])
    expect(live.find((s) => s.id === milk?.id)?.status).toBe('accepted') // kept as the user had it
    expect(h.db.select().from(tasks).all()).toHaveLength(1) // milk not duplicated
    expect(h.db.select().from(activities).get()?.state).toBe('deleted') // walk retired + undone
    expect(h.db.select().from(bullets).get()?.proc_status).toBe('needs_review') // bread pending
  })

  test('delete + extractions removes what the bullet produced', async () => {
    const h = createHarness(
      llmByText({ walk: [candidate({ fields: { name: 'walk' }, confidence: 0.95 })] }),
    )
    const b = await h.capture('went for a walk')
    await h.worker.drain()
    h.clock.now += 1000
    await h.push([op({ type: 'bullet.delete', bullet_id: b, mode: 'cascade' })])
    expect(h.db.select().from(activities).get()?.state).toBe('deleted')
    expect(h.db.select().from(bullets).get()?.state).toBe('deleted')
    expect(suggestionsOf(h, b).every((s) => s.state === 'deleted')).toBe(true)
  })

  test('delete but keep extractions keeps applied data, withdraws pending suggestions', async () => {
    const h = createHarness(
      llmByText({
        walk: [
          candidate({ fields: { name: 'walk' }, confidence: 0.95 }),
          candidate({ kind: 'task', orientation: 'future_oneoff', fields: { title: 'buy milk' } }),
        ],
      }),
    )
    const b = await h.capture('went for a walk, buy milk')
    await h.worker.drain()
    await h.push([op({ type: 'bullet.delete', bullet_id: b, mode: 'keep_extractions' })])
    expect(h.db.select().from(activities).get()?.state).toBe('active')
    const rows = suggestionsOf(h, b)
    expect(rows.find((s) => s.target_kind === 'activity')?.state).toBe('active')
    expect(rows.find((s) => s.target_kind === 'task')?.state).toBe('deleted')
  })
})
