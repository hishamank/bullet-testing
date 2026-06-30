import {
  createActivity,
  createBullet,
  createTestDb,
  createTracker,
  createUser,
  type DbConnection,
  listSuggestionsByBullet,
  rejectSuggestion,
} from '@bullet/db'
import { describe, expect, test } from 'vitest'
import { AGENT_CONFIG_DEFAULTS } from '../config'
import type { AgentDeps } from '../deps'
import { createAgentEmitter } from '../events'
import { createScriptedOllamaClient } from '../ollama/scripted'
import { createWeeklyAnalyzer } from './weekly'

function makeDeps(conn: DbConnection): AgentDeps {
  return {
    db: conn.db,
    ollama: createScriptedOllamaClient(),
    config: AGENT_CONFIG_DEFAULTS,
    emitter: createAgentEmitter(),
  }
}

function addActivity(conn: DbConnection, ownerId: string, bulletId: string, name: string) {
  createActivity(conn.db, {
    owner_id: ownerId,
    source_bullet_id: bulletId,
    name,
    occurred_at: Date.now(),
    tracker_id: null,
    notes: null,
    quantity: null,
    unit: null,
  })
}

describe('createWeeklyAnalyzer', () => {
  test('proposes a tracker definition (tier suggest) for a group at/above the threshold', () => {
    const conn = createTestDb()
    const user = createUser(conn.db, { name: 'U' })
    const bullet = createBullet(conn.db, { owner_id: user.id, text: 'seed' })
    addActivity(conn, user.id, bullet.id, 'meditate')
    addActivity(conn, user.id, bullet.id, 'Meditate ') // normalized to the same group
    addActivity(conn, user.id, bullet.id, 'meditate')

    const analyzer = createWeeklyAnalyzer(makeDeps(conn), { threshold: 3 })
    const proposals = analyzer.analyze(user.id)

    expect(proposals).toHaveLength(1)
    const p = proposals[0]
    expect(p?.target_kind).toBe('tracker')
    expect(p?.operation).toBe('create')
    expect(p?.tier).toBe('suggest')
    expect(p?.tier).not.toBe('auto')
    expect(p?.count).toBe(3)
    expect(p?.payload.name).toBe('meditate')
  })

  test('proposes nothing below the threshold', () => {
    const conn = createTestDb()
    const user = createUser(conn.db, { name: 'U' })
    const bullet = createBullet(conn.db, { owner_id: user.id, text: 'seed' })
    addActivity(conn, user.id, bullet.id, 'run')
    addActivity(conn, user.id, bullet.id, 'run')

    const analyzer = createWeeklyAnalyzer(makeDeps(conn), { threshold: 3 })
    expect(analyzer.analyze(user.id)).toHaveLength(0)
  })

  test('ignores already-linked activities', () => {
    const conn = createTestDb()
    const user = createUser(conn.db, { name: 'U' })
    const seed = createBullet(conn.db, { owner_id: user.id, text: 'seed' })
    // A tracker to link against; the linked activities must NOT count toward a new proposal.
    // We simulate "linked" by giving a tracker_id; use a real tracker id for FK integrity.
    const trackerBullet = createBullet(conn.db, { owner_id: user.id, text: 'def' })
    const tracker = createTracker(conn.db, {
      owner_id: user.id,
      source_bullet_id: trackerBullet.id,
      name: 'gym',
      input_type: 'boolean',
      config: { input_type: 'boolean' },
    })
    for (let i = 0; i < 5; i++) {
      createActivity(conn.db, {
        owner_id: user.id,
        source_bullet_id: seed.id,
        name: 'gym',
        occurred_at: Date.now(),
        tracker_id: tracker.id,
        notes: null,
        quantity: null,
        unit: null,
      })
    }

    const analyzer = createWeeklyAnalyzer(makeDeps(conn), { threshold: 3 })
    expect(analyzer.analyze(user.id)).toHaveLength(0)
  })

  test('persist() stores proposals as real pending suggestions', () => {
    const conn = createTestDb()
    const user = createUser(conn.db, { name: 'U' })
    const bullet = createBullet(conn.db, { owner_id: user.id, text: 'seed' })
    addActivity(conn, user.id, bullet.id, 'stretch')
    addActivity(conn, user.id, bullet.id, 'stretch')
    addActivity(conn, user.id, bullet.id, 'stretch')

    const analyzer = createWeeklyAnalyzer(makeDeps(conn), { threshold: 3 })
    const proposals = analyzer.analyze(user.id)
    const persisted = analyzer.persist(user.id, proposals)

    expect(persisted).toHaveLength(1)
    expect(persisted[0]?.status).toBe('pending')
    expect(persisted[0]?.tier).toBe('suggest')
    // Provenance is unchanged: the persisted suggestion still anchors to the group's source bullet.
    expect(persisted[0]?.source_bullet_id).toBe(bullet.id)
    expect(persisted[0]?.owner_id).toBe(user.id)
    expect(listSuggestionsByBullet(conn.db, bullet.id)).toHaveLength(1)
  })

  test('a re-run after persist proposes nothing new (idempotent, no duplicates)', () => {
    const conn = createTestDb()
    const user = createUser(conn.db, { name: 'U' })
    const bullet = createBullet(conn.db, { owner_id: user.id, text: 'seed' })
    addActivity(conn, user.id, bullet.id, 'journal')
    addActivity(conn, user.id, bullet.id, 'journal')
    addActivity(conn, user.id, bullet.id, 'journal')

    const analyzer = createWeeklyAnalyzer(makeDeps(conn), { threshold: 3 })

    // First run proposes + persists one pending tracker suggestion.
    const first = analyzer.analyze(user.id)
    expect(first).toHaveLength(1)
    expect(analyzer.persist(user.id, first)).toHaveLength(1)

    // Second run sees the pending tracker suggestion for 'journal' → proposes NOTHING new.
    const second = analyzer.analyze(user.id)
    expect(second).toHaveLength(0)
    // And persisting an empty proposal list writes no further suggestions.
    expect(analyzer.persist(user.id, second)).toHaveLength(0)
    expect(listSuggestionsByBullet(conn.db, bullet.id)).toHaveLength(1)
  })

  test('a rejected proposal does not resurface on a re-run (the user said no)', () => {
    const conn = createTestDb()
    const user = createUser(conn.db, { name: 'U' })
    const bullet = createBullet(conn.db, { owner_id: user.id, text: 'seed' })
    addActivity(conn, user.id, bullet.id, 'walk')
    addActivity(conn, user.id, bullet.id, 'walk')
    addActivity(conn, user.id, bullet.id, 'walk')

    const analyzer = createWeeklyAnalyzer(makeDeps(conn), { threshold: 3 })

    // First run proposes one; persist it, then the user rejects it.
    const first = analyzer.analyze(user.id)
    expect(first).toHaveLength(1)
    const [persisted] = analyzer.persist(user.id, first)
    if (!persisted) throw new Error('expected a persisted suggestion')
    rejectSuggestion(conn.db, persisted.id)

    // The rejected name is "claimed" → a manual re-run resurfaces nothing.
    expect(analyzer.analyze(user.id)).toHaveLength(0)
  })

  test('an existing active tracker with that name suppresses the proposal', () => {
    const conn = createTestDb()
    const user = createUser(conn.db, { name: 'U' })
    const seed = createBullet(conn.db, { owner_id: user.id, text: 'seed' })
    // A tracker already DEFINES "Meditate" (different casing → same normalized name).
    const defBullet = createBullet(conn.db, { owner_id: user.id, text: 'def' })
    createTracker(conn.db, {
      owner_id: user.id,
      source_bullet_id: defBullet.id,
      name: 'Meditate',
      input_type: 'boolean',
      config: { input_type: 'boolean' },
    })
    // The user keeps logging UNLINKED "meditate" activities (tracker_id null).
    addActivity(conn, user.id, seed.id, 'meditate')
    addActivity(conn, user.id, seed.id, 'meditate')
    addActivity(conn, user.id, seed.id, 'meditate')

    const analyzer = createWeeklyAnalyzer(makeDeps(conn), { threshold: 3 })
    // The active tracker already covers this name → no proposal.
    expect(analyzer.analyze(user.id)).toHaveLength(0)
  })
})
