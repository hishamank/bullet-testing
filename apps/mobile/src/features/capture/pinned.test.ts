import { describe, expect, it } from 'vite-plus/test'
import { captureBullet } from '../../data/local'
import { questions, thoughts } from '../../data/schema'
import { openTestDb, T0, testDeps } from '../../test/db'
import { findPinned, fromLabel } from './pinned'

describe('pinned question or loop', () => {
  it('finds an open question and the capture it came from', () => {
    const db = openTestDb()
    const deps = testDeps()
    const b = captureBullet(db, { text: 'dentist thursday', source: 'voice' }, deps)
    const row = { created_at: T0, updated_at: T0, source_bullet_id: b }
    db.insert(questions)
      .values({
        ...row,
        id: 'q1',
        kind: 'clarifying',
        topic: 'date',
        text: 'Which Thursday?',
        options: [],
        status: 'open',
      })
      .run()
    db.insert(thoughts)
      .values({
        ...row,
        id: 't1',
        position: 0,
        text: 'check passport',
        kind: 'to_check',
        kind_source: 'engine',
      })
      .run()

    expect(findPinned(db, { question: 'q1' })).toEqual({
      kind: 'question',
      id: 'q1',
      text: 'Which Thursday?',
      source: { source: 'voice', capturedAt: T0, timezone: 'Europe/Paris' },
    })
    expect(findPinned(db, { thought: 't1' })).toMatchObject({
      kind: 'loop',
      text: 'check passport',
    })
    expect(findPinned(db, { question: 'nope' })).toBeNull()
    expect(findPinned(db, {})).toBeNull()
  })

  it('says where the pinned thing came from, in the capture zone', () => {
    const src = { source: 'voice' as const, capturedAt: T0, timezone: 'Europe/Paris' }
    expect(fromLabel(src, T0 + 3_600_000)).toBe('From your voice note, today 09:12')
    expect(fromLabel({ ...src, source: 'text' }, T0 + 86_400_000)).toBe(
      'From your note, yesterday 09:12',
    )
    expect(fromLabel(src, T0 + 5 * 86_400_000)).toBe('From your voice note, 15 Oct 09:12')
  })
})
