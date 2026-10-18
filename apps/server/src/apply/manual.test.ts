import { pullResponseSchema } from '@bullet/core'
import { describe, expect, test } from 'vite-plus/test'
import { bullets, events, suggestions, tasks, trackerEntries } from '../db/schema'
import { candidate, createHarness, llmByText, T0, uid } from '../test/helpers'
import { insertEntity } from './entities'

const llm = () =>
  llmByText({
    landlord: [
      candidate({
        kind: 'task',
        orientation: 'future_oneoff',
        fields: { title: 'Call the landlord', when: 'tomorrow' },
      }),
    ],
    dinner: [
      candidate({
        kind: 'event',
        orientation: 'future_oneoff',
        fields: { title: 'Dinner with Sara', when: 'tomorrow 8pm' },
      }),
    ],
  })

/** Capture, process and accept: returns the applied thing's id and its suggestion. */
async function appliedThing(h: ReturnType<typeof createHarness>, text: string) {
  const bullet = await h.capture(text)
  await h.worker.drain()
  const s = h.db.select().from(suggestions).all().at(-1)
  if (!s) throw new Error('no suggestion')
  await h.push([{ op_id: uid(), type: 'suggestion.accept', suggestion_id: s.id }])
  return { bullet, id: s.id }
}

describe('manual edits', () => {
  test('complete / reopen / reschedule / rename a task; each marks it edited by the user', async () => {
    const h = createHarness(llm())
    const { id } = await appliedThing(h, 'call the landlord tomorrow')
    h.clock.now = T0 + 60_000
    const res = await h.push([
      { op_id: uid(), type: 'task.update', task_id: id, patch: { status: 'done' } },
      { op_id: uid(), type: 'task.update', task_id: id, patch: { title: 'Call Mr Haddad' } },
      { op_id: uid(), type: 'task.update', task_id: id, patch: { due_at: null } },
    ])
    expect(res.results.map((r) => r.status)).toEqual(['applied', 'applied', 'applied'])
    expect(h.db.select().from(tasks).get()).toMatchObject({
      status: 'done',
      title: 'Call Mr Haddad',
      due_at: null,
      user_edited_at: T0 + 60_000,
    })
    await h.push([{ op_id: uid(), type: 'task.update', task_id: id, patch: { status: 'todo' } }])
    expect(h.db.select().from(tasks).get()?.status).toBe('todo')

    const pulled = pullResponseSchema.parse(await h.pull())
    expect(pulled.changes.tasks[0]?.user_edited_at).toBe(T0 + 60_000)
  })

  test('undo of the suggestion that made it is refused once edited by hand', async () => {
    const h = createHarness(llm())
    const { id } = await appliedThing(h, 'call the landlord tomorrow')
    h.clock.now = T0 + 60_000
    await h.push([{ op_id: uid(), type: 'task.update', task_id: id, patch: { status: 'done' } }])
    const res = await h.push([{ op_id: uid(), type: 'suggestion.undo', suggestion_id: id }])
    expect(res.results[0]).toMatchObject({ status: 'rejected', error: { code: 'conflict' } })
    expect(h.db.select().from(tasks).get()?.state).toBe('active')
  })

  test('reprocessing never overwrites a hand-edited thing', async () => {
    const h = createHarness(llm())
    const { bullet, id } = await appliedThing(h, 'call the landlord tomorrow')
    h.clock.now = T0 + 60_000
    await h.push([{ op_id: uid(), type: 'task.update', task_id: id, patch: { title: 'Mine' } }])
    // The edit drops the task from the text: its suggestion is withdrawn, the user's task stays.
    h.clock.now = T0 + 120_000
    await h.push([
      { op_id: uid(), type: 'bullet.edit', bullet_id: bullet, text: 'nothing', edited_at: T0 + 1 },
    ])
    await h.worker.drain()
    expect(h.db.select().from(suggestions).get()?.state).toBe('deleted')
    expect(h.db.select().from(tasks).get()).toMatchObject({ state: 'active', title: 'Mine' })
  })

  test('delete is soft, idempotent, and later edits are invalid', async () => {
    const h = createHarness(llm())
    const { id } = await appliedThing(h, 'call the landlord tomorrow')
    const res = await h.push([
      { op_id: uid(), type: 'task.delete', task_id: id },
      { op_id: uid(), type: 'task.delete', task_id: id },
      { op_id: uid(), type: 'task.update', task_id: id, patch: { status: 'done' } },
      { op_id: uid(), type: 'task.delete', task_id: uid() },
    ])
    expect(res.results.map((r) => (r.status === 'rejected' ? r.error.code : r.status))).toEqual([
      'applied',
      'applied',
      'invalid',
      'not_found',
    ])
    expect(h.db.select().from(tasks).get()).toMatchObject({ state: 'deleted', user_edited_at: T0 })
  })

  test('move or rename an event; it can never end before it starts', async () => {
    const h = createHarness(llm())
    const { id } = await appliedThing(h, 'dinner tomorrow 8pm')
    const e = h.db.select().from(events).get()
    if (!e) throw new Error('no event')
    const later = e.starts_at + 3_600_000
    const res = await h.push([
      { op_id: uid(), type: 'event.update', event_id: id, patch: { starts_at: later } },
      { op_id: uid(), type: 'event.update', event_id: id, patch: { ends_at: e.starts_at } },
      {
        op_id: uid(),
        type: 'event.update',
        event_id: id,
        patch: { title: 'Dinner at Sara’s', ends_at: later + 7_200_000 },
      },
    ])
    expect(res.results.map((r) => (r.status === 'rejected' ? r.error.code : r.status))).toEqual([
      'applied',
      'invalid',
      'applied',
    ])
    expect(h.db.select().from(events).get()).toMatchObject({
      title: 'Dinner at Sara’s',
      starts_at: later,
      ends_at: later + 7_200_000,
      user_edited_at: T0,
    })
    await h.push([{ op_id: uid(), type: 'event.delete', event_id: id }])
    expect(h.db.select().from(events).get()?.state).toBe('deleted')
  })

  test("a reading's value must fit its tracker", async () => {
    const h = createHarness()
    const b = await h.capture('mood')
    const tracker = uid()
    const entry = uid()
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
      T0,
    )
    insertEntity(
      h.db,
      'tracker_entry',
      {
        id: entry,
        owner_id: h.ownerId,
        source_bullet_id: b,
        tracker_id: tracker,
        value: 2,
        logged_at: T0,
      },
      T0,
    )
    const res = await h.push([
      { op_id: uid(), type: 'tracker_entry.update', tracker_entry_id: entry, patch: { value: 9 } },
      {
        op_id: uid(),
        type: 'tracker_entry.update',
        tracker_entry_id: entry,
        patch: { value: 'x' },
      },
      { op_id: uid(), type: 'tracker_entry.update', tracker_entry_id: entry, patch: { value: 4 } },
      { op_id: uid(), type: 'tracker_entry.delete', tracker_entry_id: entry },
    ])
    expect(res.results.map((r) => (r.status === 'rejected' ? r.error.code : r.status))).toEqual([
      'invalid',
      'invalid',
      'applied',
      'applied',
    ])
    expect(h.db.select().from(trackerEntries).get()).toMatchObject({
      value: 4,
      state: 'deleted',
      user_edited_at: T0,
    })
    // Untouched by any of it.
    expect(h.db.select().from(bullets).get()?.state).toBe('active')
  })
})
