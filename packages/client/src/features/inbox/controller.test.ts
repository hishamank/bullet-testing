import { describe, expect, test } from 'vite-plus/test'
import { listRejections } from '../../data/rejections'
import { bullets, outbox, suggestions } from '../../data/schema'
import { openTestDb, T0, testDeps } from '../../test/db'
import { createInboxController, UNDO_MESSAGES } from './controller'
import { UNDO_WINDOW_MS } from './undo'

// All sample content is made up.
const B1 = '00000000-0000-4000-8000-000000000b01'
const S1 = '00000000-0000-4000-8000-000000000e01'
const S2 = '00000000-0000-4000-8000-000000000e02'

/** A controller over an in-memory mirror with a manual clock and manual timers. */
function setup() {
  const db = openTestDb()
  const deps = testDeps()
  const timers: { fn: () => void; at: number }[] = []
  const log = { notified: 0, synced: 0, announced: [] as string[] }
  db.insert(bullets)
    .values({
      id: B1,
      text: 'dentist on thursday and mood is a 4',
      source: 'text',
      captured_at: T0,
      timezone: 'Europe/Paris',
      server_status: 'processed',
      created_at: T0,
      updated_at: T0,
    })
    .run()
  for (const [id, title] of [
    [S1, 'Dentist'],
    [S2, 'Call mom'],
  ] as const) {
    db.insert(suggestions)
      .values({
        id,
        source_bullet_id: B1,
        target_kind: 'task',
        operation: 'create',
        payload: { title },
        confidence: 0.9,
        tier: 'suggest',
        status: 'pending',
        auto_applied: false,
        created_at: T0,
        updated_at: T0,
      })
      .run()
  }
  const controller = createInboxController({
    db: () => db,
    deps,
    notify: () => {
      log.notified += 1
    },
    syncNow: () => {
      log.synced += 1
    },
    announce: (m) => log.announced.push(m),
    now: () => deps.clock.now,
    setTimer: (fn, ms) => {
      const t = { fn, at: deps.clock.now + ms }
      timers.push(t)
      return t
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h as (typeof timers)[number])
      if (i >= 0) timers.splice(i, 1)
    },
  })
  /** Move the clock and run the timers that are due. */
  const advance = (ms: number) => {
    deps.clock.now += ms
    for (const t of timers.slice()) {
      if (t.at <= deps.clock.now) {
        timers.splice(timers.indexOf(t), 1)
        t.fn()
      }
    }
  }
  const held = () =>
    db
      .select()
      .from(outbox)
      .all()
      .filter((o) => o.hold_until !== null)
  const status = (id: string) =>
    db
      .select()
      .from(suggestions)
      .all()
      .find((s) => s.id === id)?.status
  return { db, controller, log, advance, held, status, timers }
}

describe('inbox controller', () => {
  test('accepting writes at once, holds the op, and sends it when the window closes', () => {
    const t = setup()
    t.controller.accept(S1, 'Dentist')
    expect(t.status(S1)).toBe('accepted')
    expect(t.held()).toHaveLength(1)
    expect(t.controller.undoStore.get()).toHaveLength(1)
    expect(t.log.announced).toEqual(['Added Dentist. Undo is available for a few seconds.'])
    expect(t.log.synced).toBe(0)

    t.advance(UNDO_WINDOW_MS - 1)
    expect(t.held()).toHaveLength(1)
    t.advance(1)
    expect(t.held()).toHaveLength(0)
    expect(t.controller.undoStore.get()).toHaveLength(0)
    expect(t.log.synced).toBe(1)
  })

  test('Undo inside the window takes the decision back; the server never sees it', () => {
    const t = setup()
    t.controller.dismiss(S1, 'Dentist')
    expect(t.status(S1)).toBe('rejected')
    expect(t.controller.undoDecision(S1)).toBe('restored')
    expect(t.status(S1)).toBe('pending')
    expect(t.db.select().from(outbox).all()).toHaveLength(0)
    expect(t.log.announced.at(-1)).toBe(UNDO_MESSAGES.restored)
    expect(t.controller.undoStore.get()).toHaveLength(0)
  })

  test('Accept both holds both ops in one window; a double tap decides once', () => {
    const t = setup()
    t.controller.acceptAll([S1, S2])
    t.controller.acceptAll([S1, S2])
    expect(t.held()).toHaveLength(2)
    expect(t.log.announced).toEqual(['Added 2. Undo is available for a few seconds.'])
    t.advance(UNDO_WINDOW_MS)
    expect(t.held()).toHaveLength(0)
  })

  test('leaving the Inbox sends what is still in its window', () => {
    const t = setup()
    t.controller.accept(S1, 'Dentist')
    t.controller.flushDecisions()
    expect(t.held()).toHaveLength(0)
    expect(t.controller.undoStore.get()).toHaveLength(0)
    expect(t.log.synced).toBe(1)
    // Nothing left: a second flush neither syncs nor notifies again.
    const notified = t.log.notified
    t.controller.flushDecisions()
    expect(t.log.synced).toBe(1)
    expect(t.log.notified).toBe(notified)
  })

  test('Undo after the window: an accepted one is undone the server way', () => {
    const t = setup()
    t.controller.accept(S1, 'Dentist')
    // The window closes, the op is "sent" (outbox emptied), then Undo is tapped from the old row.
    const entry = t.controller.undoStore.get()[0]
    t.advance(UNDO_WINDOW_MS)
    t.db.delete(outbox).run()
    t.controller.undoStore.set(entry ? [entry] : [])
    expect(t.controller.undoDecision(S1)).toBe('undone')
    expect(t.log.synced).toBeGreaterThan(1)
  })

  test('an Undo of a dismissal that was already sent says so and changes nothing', () => {
    const t = setup()
    t.controller.dismiss(S1, 'Dentist')
    const entry = t.controller.undoStore.get()[0]
    t.advance(UNDO_WINDOW_MS)
    t.db.delete(outbox).run()
    t.controller.undoStore.set(entry ? [entry] : [])
    expect(t.controller.undoDecision(S1)).toBe('already_sent')
    expect(t.status(S1)).toBe('rejected')
    expect(t.log.announced.at(-1)).toBe(UNDO_MESSAGES.already_sent)
  })

  test('a refused notice can be dismissed', () => {
    const t = setup()
    expect(listRejections(t.db)).toHaveLength(0)
    t.controller.dismissNotice('nothing-here')
    expect(t.log.notified).toBe(1)
  })
})
