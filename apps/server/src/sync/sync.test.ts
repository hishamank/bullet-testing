import { describe, expect, test } from 'vite-plus/test'
import { bullets } from '../db/schema'
import { createHarness, T0, uid } from '../test/helpers'

const create = (id: string, text = 'ran 5k', op_id = uid()) => ({
  op_id,
  type: 'bullet.create' as const,
  bullet: { id, text, captured_at: T0, timezone: 'Europe/Paris', source: 'text' as const },
})

describe('push is idempotent', () => {
  test('the same op twice → applied, then duplicate; one bullet', async () => {
    const h = createHarness()
    const op = create(uid())
    expect((await h.push([op])).results).toEqual([{ op_id: op.op_id, status: 'applied' }])
    expect((await h.push([op])).results).toEqual([{ op_id: op.op_id, status: 'duplicate' }])
    expect(h.db.select().from(bullets).all()).toHaveLength(1)
  })

  test('the same bullet id under a new op_id is a duplicate, not a second bullet', async () => {
    const h = createHarness()
    const id = uid()
    await h.push([create(id)])
    expect((await h.push([create(id)])).results[0]?.status).toBe('duplicate')
    expect(h.db.select().from(bullets).all()).toHaveLength(1)
  })

  test('a bullet id reused for a different capture is refused', async () => {
    const h = createHarness()
    const id = uid()
    await h.push([create(id, 'one')])
    const other = create(id, 'two')
    const res = (await h.push([{ ...other, bullet: { ...other.bullet, captured_at: T0 + 1 } }]))
      .results[0]
    expect(res).toMatchObject({ status: 'rejected', error: { code: 'invalid' } })
  })

  test('a replayed rejection returns the same rejection', async () => {
    const h = createHarness()
    const op = { op_id: uid(), type: 'bullet.retry' as const, bullet_id: uid() }
    const first = (await h.push([op])).results[0]
    expect(first).toMatchObject({ status: 'rejected', error: { code: 'not_found' } })
    expect((await h.push([op])).results[0]).toEqual(first)
  })

  test('ops apply in order within a batch (create then edit)', async () => {
    const h = createHarness()
    const id = uid()
    const res = await h.push([
      create(id, 'draft'),
      { op_id: uid(), type: 'bullet.edit', bullet_id: id, text: 'final', edited_at: T0 + 1 },
    ])
    expect(res.results.map((r) => r.status)).toEqual(['applied', 'applied'])
    expect(h.db.select().from(bullets).get()?.text).toBe('final')
  })

  test('an edit older than the current text is stale', async () => {
    const h = createHarness()
    const id = uid()
    await h.push([
      create(id, 'v1'),
      { op_id: uid(), type: 'bullet.edit', bullet_id: id, text: 'v3', edited_at: T0 + 10 },
    ])
    const res = await h.push([
      { op_id: uid(), type: 'bullet.edit', bullet_id: id, text: 'v2', edited_at: T0 + 5 },
    ])
    expect(res.results[0]).toMatchObject({ status: 'rejected', error: { code: 'stale' } })
  })
})

describe('pull is incremental', () => {
  test('full pull, then nothing new, then only what changed', async () => {
    const h = createHarness()
    const a = await h.capture('first')
    const first = await h.pull()
    expect(first.changes.bullets.map((b) => b.id)).toEqual([a])
    expect(first.changes.bullets[0]?.processing.status).toBe('synced')
    expect(first.has_more).toBe(false)

    const empty = await h.pull(first.cursor)
    expect(empty.changes.bullets).toEqual([])
    expect(empty.cursor).toBe(first.cursor)

    const b = await h.capture('second')
    const next = await h.pull(first.cursor)
    expect(next.changes.bullets.map((x) => x.id)).toEqual([b])
  })

  test('pages with has_more; each row once, in its latest version', async () => {
    const h = createHarness()
    const ids = [await h.capture('a'), await h.capture('b'), await h.capture('c')]
    const p1 = await h.pull(undefined, 2)
    expect(p1.has_more).toBe(true)
    const p2 = await h.pull(p1.cursor, 2)
    expect(p2.has_more).toBe(false)
    const seen = [...p1.changes.bullets, ...p2.changes.bullets].map((b) => b.id)
    const byText = (a: string, b: string) => a.localeCompare(b)
    expect(seen.sort(byText)).toEqual(ids.sort(byText))
  })

  test('soft-deleted rows are sent with state deleted', async () => {
    const h = createHarness()
    const id = await h.capture('oops')
    const { cursor } = await h.pull()
    await h.push([{ op_id: uid(), type: 'bullet.delete', bullet_id: id, mode: 'cascade' }])
    const res = await h.pull(cursor)
    expect(res.changes.bullets).toMatchObject([{ id, state: 'deleted' }])
  })
})
