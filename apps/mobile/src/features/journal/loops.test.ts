import { describe, expect, test } from 'vite-plus/test'
import { captureBullet, resolveThought, unresolveThought } from '../../data/local'
import { openTestDb, T0, testDeps } from '../../test/db'
import { seedBullet, seedThought } from './fixtures'
import { listLoops, loopSourceLine } from './loops'

describe('open loops', () => {
  test('lists open to-check and self-questions, newest capture first; other kinds never', () => {
    const db = openTestDb()
    const a = seedBullet(db, T0 - 86_400_000, { source: 'voice' })
    const b = seedBullet(db, T0)
    const passport = seedThought(db, a, 0, 'to_check', 'Whether the passport expires before March')
    const lock = seedThought(db, b, 0, 'to_check', 'Price of a bike lock')
    const role = seedThought(db, a, 1, 'question', 'Do I want the new role?')
    seedThought(db, a, 2, 'worry', 'Uneasy about the talk')
    const loops = listLoops(db)
    expect(loops.toCheck.map((l) => l.id)).toEqual([lock, passport])
    expect(loops.questions.map((l) => l.id)).toEqual([role])
    expect(loops.done).toEqual([])
    expect(loopSourceLine(loops.toCheck[1]!, T0)).toBe('Voice note · yesterday 09:12')
  })

  test('check off moves a loop to Done; reopen brings it back', () => {
    const db = openTestDb()
    const deps = testDeps()
    const b = seedBullet(db, T0)
    const t = seedThought(db, b, 0, 'to_check', 'If the pool opens on Sundays')
    resolveThought(db, t, deps)
    expect(listLoops(db)).toMatchObject({ toCheck: [], done: [{ id: t, resolvedAt: T0 }] })
    unresolveThought(db, t, deps)
    expect(listLoops(db)).toMatchObject({ toCheck: [{ id: t }], done: [] })
  })

  test('closing with a note links the note capture and resolves at once', () => {
    const db = openTestDb()
    const b = seedBullet(db, T0)
    const t = seedThought(db, b, 0, 'question', 'What would a calmer morning look like?')
    const note = captureBullet(db, { text: 'Fewer screens', resolvesThoughtId: t }, testDeps())
    expect(listLoops(db).done).toMatchObject([{ id: t, resolvedByBulletId: note }])
  })

  test("a deleted capture's loops disappear", () => {
    const db = openTestDb()
    const b = seedBullet(db, T0, { state: 'deleted' })
    seedThought(db, b, 0, 'to_check', 'gone')
    expect(listLoops(db).toCheck).toEqual([])
  })
})
