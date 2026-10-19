import { pushOpSchema } from '@bullet/core'
import { describe, expect, test } from 'vite-plus/test'
import { openTestDb, T0, testDeps } from '../test/db'
import { migrate } from './db'
import {
  acceptSuggestion,
  captureBullet,
  deleteBullet,
  editBullet,
  rejectSuggestion,
  retryBullet,
} from './local'
import { listBullets } from './queries'
import { bullets, outbox, suggestions } from './schema'

describe('on-device migrations', () => {
  test('are idempotent (safe on every app start)', () => {
    const db = openTestDb()
    expect(migrate(db)).toBe(0)
  })
})

describe('capture', () => {
  test('writes the bullet and its outbox op together; shows saved_local', () => {
    const db = openTestDb()
    const id = captureBullet(db, { text: '  dentist thursday 3pm ', source: 'voice' }, testDeps())

    expect(db.select().from(bullets).all()).toMatchObject([
      {
        id,
        text: 'dentist thursday 3pm',
        captured_at: T0,
        timezone: 'Europe/Paris',
        source: 'voice',
      },
    ])
    const [op] = db.select().from(outbox).all()
    expect(op).toMatchObject({ type: 'bullet.create', bullet_id: id })
    expect(pushOpSchema.safeParse(op?.op).success).toBe(true)
    expect(listBullets(db)[0]?.status).toBe('saved_local')
  })

  test('is atomic: if the outbox write fails, the bullet is not saved either', () => {
    const db = openTestDb()
    const deps = testDeps()
    // uuid() is called for the bullet id, then the op_id. Force the 2nd capture's op_id to collide.
    const ids = ['b1', 'op-1', 'b2', 'op-1']
    const scripted = { ...deps, uuid: () => ids.shift() ?? '' }
    captureBullet(db, { text: 'one' }, scripted)
    expect(() => captureBullet(db, { text: 'two' }, scripted)).toThrow()
    expect(
      db
        .select()
        .from(bullets)
        .all()
        .map((b) => b.id),
    ).toEqual(['b1'])
    expect(db.select().from(outbox).all()).toHaveLength(1)
  })

  test('refuses an empty bullet', () => {
    expect(() => captureBullet(openTestDb(), { text: '   ' }, testDeps())).toThrow()
  })
})

describe('other local actions queue their ops in order', () => {
  test('edit, retry, delete', () => {
    const db = openTestDb()
    const deps = testDeps()
    const id = captureBullet(db, { text: 'v1' }, deps)
    deps.clock.now += 1000
    editBullet(db, id, 'v2', deps)
    retryBullet(db, id, deps)
    deleteBullet(db, id, 'keep_extractions', deps)
    const ops = db
      .select()
      .from(outbox)
      .all()
      .map((r) => r.op)
    expect(ops.map((o) => o.type)).toEqual([
      'bullet.create',
      'bullet.edit',
      'bullet.retry',
      'bullet.delete',
    ])
    expect(ops[1]).toMatchObject({ text: 'v2', edited_at: T0 + 1000 })
    expect(db.select().from(bullets).get()).toMatchObject({ text: 'v2', state: 'deleted' })
    expect(listBullets(db)).toEqual([])
  })

  test('accept / reject update the mirror optimistically', () => {
    const db = openTestDb()
    const deps = testDeps()
    const base = {
      source_bullet_id: 'b',
      target_kind: 'task' as const,
      operation: 'create' as const,
      target_id: null,
      payload: { title: 'x' },
      confidence: 0.8,
      tier: 'suggest' as const,
      status: 'pending' as const,
      resolved_at: null,
      applied_entity_id: null,
      applied_at: null,
      auto_applied: false,
      created_at: T0,
      updated_at: T0,
    }
    db.insert(suggestions)
      .values([
        { ...base, id: 's1' },
        { ...base, id: 's2' },
      ])
      .run()
    acceptSuggestion(db, 's1', deps, { title: 'y' })
    rejectSuggestion(db, 's2', deps)
    const rows = db.select().from(suggestions).all()
    expect(rows.find((r) => r.id === 's1')).toMatchObject({
      status: 'edited',
      payload: { title: 'y' },
    })
    expect(rows.find((r) => r.id === 's2')?.status).toBe('rejected')
    expect(
      db
        .select()
        .from(outbox)
        .all()
        .map((r) => r.type),
    ).toEqual(['suggestion.accept', 'suggestion.reject'])
  })
})
