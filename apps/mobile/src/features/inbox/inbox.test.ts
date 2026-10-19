import type { PullResponse, PushRequest, PushResponse } from '@bullet/core'
import { zonedToEpoch } from '@bullet/engine'
import { describe, expect, test } from 'vite-plus/test'
import { decideHeld, releaseHolds, retractDecision } from '../../data/decisions'
import {
  acceptSuggestion,
  answerQuestion,
  captureBullet,
  rejectSuggestion,
  undoSuggestion,
} from '../../data/local'
import { CURSOR_KEY, getState, setState } from '../../data/mirror'
import { clearRejection, listRejections } from '../../data/rejections'
import { bullets, outbox, questions, suggestions, trackers } from '../../data/schema'
import { createSyncClient } from '../../sync/client'
import type { SyncTransport } from '../../sync/transport'
import { openTestDb, T0, testDeps } from '../../test/db'
import { applyEdit, editFormFor, parseNumber } from './edit'
import { buildInbox, loadInboxRows, noticeText, startOfDay } from './model'
import { formatValue, formatWhen, snippet, summarize, type SummaryContext } from './summary'
import { addDecision, expireDecisions, nextExpiry, removeDecision, UNDO_WINDOW_MS } from './undo'

// All sample content is made up.
const TZ = 'Europe/Paris'
const paris = (day: number, hour: number, minute = 0) =>
  zonedToEpoch({ year: 2026, month: 10, day, hour, minute }, TZ)

const B1 = '00000000-0000-4000-8000-000000000b01'
const B2 = '00000000-0000-4000-8000-000000000b02'
const S_EVENT = '00000000-0000-4000-8000-000000000e01'
const S_MOOD = '00000000-0000-4000-8000-000000000e02'
const S_TRACKER = '00000000-0000-4000-8000-000000000e03'
const S_RUN = '00000000-0000-4000-8000-000000000e04'
const MOOD = '00000000-0000-4000-8000-000000000d01'
const TASK = '00000000-0000-4000-8000-000000000d02'
const Q = '00000000-0000-4000-8000-000000000c01'

const ctx = (over: Partial<SummaryContext> = {}): SummaryContext => ({
  now: T0, // Thursday 15 Oct 2026, 09:12 in Paris
  timezone: TZ,
  trackers: new Map([[MOOD, { name: 'Mood', config: { input_type: 'scale', min: 1, max: 5 } }]]),
  titles: new Map([[TASK, 'Call mom']]),
  ...over,
})

describe('formatWhen', () => {
  test('names today and tomorrow, the coming week by weekday, later dates in full', () => {
    expect(formatWhen(paris(15, 15), T0, TZ).text).toBe('Today 15:00')
    expect(formatWhen(paris(16, 9, 5), T0, TZ).text).toBe('Tomorrow 09:05')
    expect(formatWhen(paris(20, 15), T0, TZ)).toEqual({
      text: 'Tue 15:00',
      spoken: 'Tuesday 15:00',
    })
    expect(formatWhen(paris(22, 15), T0, TZ)).toEqual({
      text: 'Thu 22 Oct 15:00',
      spoken: 'Thursday 22 October 15:00',
    })
    expect(formatWhen(paris(14, 18), T0, TZ).text).toBe('Yesterday 18:00')
  })

  test('drops the time for all-day dates and adds the year when it differs', () => {
    expect(formatWhen(paris(20, 0), T0, TZ, true).text).toBe('Tue')
    const nextYear = zonedToEpoch({ year: 2027, month: 1, day: 7, hour: 10 }, TZ)
    expect(formatWhen(nextYear, T0, TZ).text).toBe('Thu 7 Jan 2027 10:00')
  })

  test('reads the clock in the given zone', () => {
    // 22:30 UTC on the 15th is already the 16th in Beirut.
    expect(formatWhen(Date.UTC(2026, 9, 15, 22, 30), T0, 'Asia/Beirut').text).toBe('Tomorrow 01:30')
  })
})

describe('summaries', () => {
  const create = (
    target_kind: 'event' | 'task' | 'tracker' | 'tracker_entry' | 'activity',
    payload: object,
  ) => ({
    target_kind,
    operation: 'create' as const,
    target_id: null,
    payload: payload as Record<string, unknown>,
  })

  test('an event shows its title and when', () => {
    const s = summarize(create('event', { title: 'Dentist', starts_at: paris(20, 15) }), ctx())
    expect(s).toMatchObject({
      pill: { kind: 'event', label: 'event' },
      text: 'Dentist · Tue 15:00',
      spoken: 'Dentist, Tuesday 15:00',
      name: 'Dentist',
    })
  })

  test('a reading shows the tracker and value against its scale', () => {
    const s = summarize(
      {
        target_kind: 'tracker_entry',
        operation: 'append',
        target_id: MOOD,
        payload: { tracker_id: MOOD, value: 3 },
      },
      ctx(),
    )
    expect(s).toMatchObject({
      pill: { kind: 'tracker', label: 'mood' },
      text: 'Mood · 3 / 5',
      spoken: 'Mood, 3 out of 5',
      done: 'Mood · 3 / 5 logged',
    })
  })

  test('a new tracker is labelled as such, with its shape', () => {
    const s = summarize(
      create('tracker', {
        name: 'Water',
        input_type: 'number',
        config: { input_type: 'number', unit: 'glasses' },
      }),
      ctx(),
    )
    expect(s.pill.label).toBe('new tracker')
    expect(s.text).toBe('Water · number · glasses')
  })

  test('an activity shows its amount; a task its due date', () => {
    expect(
      summarize(create('activity', { name: 'Run', quantity: 5, unit: 'km' }), ctx()).done,
    ).toBe('Run · 5 km logged')
    expect(
      summarize(create('task', { title: 'Book flights', due_at: paris(16, 18) }), ctx()).text,
    ).toBe('Book flights · due Tomorrow 18:00')
  })

  test('an update names the existing thing', () => {
    const s = summarize(
      { target_kind: 'task', operation: 'update', target_id: TASK, payload: { status: 'done' } },
      ctx(),
    )
    expect(s.text).toBe('“Call mom” · mark done')
    expect(s.done).toBe('“Call mom” marked done')
  })

  test('values and snippets', () => {
    expect(formatValue(true)).toBe('Yes')
    expect(formatValue(['tea', 'coffee'])).toBe('tea, coffee')
    expect(formatValue(72, { input_type: 'number', unit: 'kg' })).toBe('72 kg')
    expect(snippet('dentist   thursday')).toBe('“dentist thursday”')
    expect(snippet('a '.repeat(80), 20).endsWith('…”')).toBe(true)
  })
})

describe('undo window', () => {
  const entry = (id: string, at: number) => ({
    suggestionId: id,
    decision: 'accepted' as const,
    bulletId: B1,
    decidedAt: at,
    previousPayload: {},
  })

  test('entries expire after the window; the next expiry drives one timer', () => {
    let s = addDecision([], entry('a', 0))
    s = addDecision(s, entry('b', 1_000))
    expect(nextExpiry(s)).toBe(UNDO_WINDOW_MS)
    expect(expireDecisions(s, UNDO_WINDOW_MS - 1)).toBe(s)
    expect(expireDecisions(s, UNDO_WINDOW_MS).map((e) => e.suggestionId)).toEqual(['b'])
    expect(nextExpiry([])).toBeNull()
  })

  test('re-deciding replaces the entry; removing is a no-op when absent', () => {
    const s = addDecision(addDecision([], entry('a', 0)), {
      ...entry('a', 50),
      decision: 'dismissed',
    })
    expect(s).toHaveLength(1)
    expect(s[0]?.decision).toBe('dismissed')
    expect(removeDecision(s, 'zzz')).toBe(s)
  })
})

// --- the read model over a real (in-memory) mirror ---

function row(
  id: string,
  bullet: string,
  target_kind: 'event' | 'tracker_entry' | 'tracker' | 'activity' | 'task',
  payload: object,
  over: object = {},
) {
  return {
    id,
    created_at: T0,
    updated_at: T0,
    state: 'active' as const,
    source_bullet_id: bullet,
    source_thought_id: null,
    target_kind,
    operation: 'create' as const,
    target_id: null,
    payload: payload as Record<string, unknown>,
    confidence: 0.7,
    tier: 'suggest' as const,
    status: 'pending' as const,
    resolved_at: null,
    applied_entity_id: null,
    applied_at: null,
    auto_applied: false,
    ...over,
  }
}

function seed() {
  const db = openTestDb()
  const deps = testDeps()
  const b = (id: string, text: string, source: 'text' | 'voice') => ({
    id,
    text,
    captured_at: T0 - 60_000,
    timezone: TZ,
    source,
    created_at: T0,
    updated_at: T0,
    server_status: 'needs_review' as const,
  })
  db.insert(bullets)
    .values([
      b(B1, 'dentist tuesday at three, mood is like a 3 today', 'voice'),
      b(B2, 'start tracking water, ran 5k', 'text'),
    ])
    .run()
  db.insert(trackers)
    .values({
      id: MOOD,
      created_at: 1,
      updated_at: 1,
      state: 'active',
      name: 'Mood',
      input_type: 'scale',
      config: { input_type: 'scale', min: 1, max: 5 },
      source_bullet_id: null,
      source_thought_id: null,
    })
    .run()
  db.insert(suggestions)
    .values([
      row(S_EVENT, B1, 'event', {
        title: 'Dentist',
        starts_at: paris(20, 15),
        ends_at: paris(20, 16),
        all_day: false,
      }),
      row(
        S_MOOD,
        B1,
        'tracker_entry',
        { tracker_id: MOOD, value: 3, logged_at: T0 },
        { operation: 'append', target_id: MOOD },
      ),
      row(S_TRACKER, B2, 'tracker', {
        name: 'Water',
        input_type: 'number',
        config: { input_type: 'number', unit: 'glasses' },
      }),
      row(
        S_RUN,
        B2,
        'activity',
        { name: 'Run', occurred_at: T0, quantity: 5, unit: 'km' },
        {
          status: 'accepted',
          tier: 'auto',
          auto_applied: true,
          applied_at: T0,
          resolved_at: T0,
          applied_entity_id: '00000000-0000-4000-8000-000000000f01',
        },
      ),
    ])
    .run()
  return { db, deps }
}

const load = (db: ReturnType<typeof openTestDb>, heldIds: string[] = [], now = T0) =>
  loadInboxRows(db, { now, timezone: TZ, heldIds })

describe('the Inbox read model', () => {
  test('groups pending suggestions by capture, with snippet, source and the new-tracker note', () => {
    const { db } = seed()
    const view = buildInbox(load(db), [])
    expect(view.pendingCount).toBe(3)
    expect(
      view.groups.map((g) => [g.bulletId, g.source, g.items.map((i) => i.summary.text)]),
    ).toEqual([
      [B1, 'voice', ['Dentist · Tue 15:00', 'Mood · 3 / 5']],
      [B2, 'text', ['Water · number · glasses']],
    ])
    expect(view.groups[0]?.snippet).toBe('“dentist tuesday at three, mood is like a 3 today”')
    expect(view.groups.map((g) => g.hasNewTracker)).toEqual([false, true])
    expect(view.groups[0]?.items.every((i) => i.editable)).toBe(true)
  })

  test('a decided suggestion keeps its place while its Undo window is open', () => {
    const { db, deps } = seed()
    acceptSuggestion(db, S_EVENT, deps)
    const undo = addDecision([], {
      suggestionId: S_EVENT,
      decision: 'accepted',
      bulletId: B1,
      decidedAt: T0,
      previousPayload: {},
    })
    const held = buildInbox(load(db, [S_EVENT]), undo)
    expect(held.groups[0]?.items.map((i) => i.decision)).toEqual(['accepted', null])
    expect(held.groups[0]?.pending.map((i) => i.id)).toEqual([S_MOOD])
    expect(held.pendingCount).toBe(2)
    // Once the window closes it leaves the list (accepted by hand: not "done for you").
    const after = buildInbox(load(db), [])
    expect(after.groups[0]?.items.map((i) => i.id)).toEqual([S_MOOD])
    expect(after.done.map((d) => d.suggestionId)).toEqual([S_RUN])
  })

  test('Done for you today: auto-applied items and items applied by tapping an answer', () => {
    const { db, deps } = seed()
    db.insert(questions)
      .values({
        id: Q,
        created_at: T0,
        updated_at: T0,
        state: 'active',
        source_bullet_id: B1,
        source_thought_id: null,
        suggestion_id: S_EVENT,
        kind: 'clarifying',
        topic: 'date',
        text: 'Dentist on Tuesday: this week or next?',
        options: ['This Tuesday', 'Next Tuesday', 'Some other day', 'Never mind', 'Too many'],
        status: 'open',
        answer_bullet_id: null,
        answer_option: null,
        resolved_at: null,
      })
      .run()
    const before = buildInbox(load(db), [])
    expect(before.questions).toHaveLength(1)
    expect(before.questions[0]?.options).toHaveLength(4)
    expect(before.questions[0]).toMatchObject({
      bulletId: B1,
      snippet: '“dentist tuesday at three, mood is like a 3 today”',
      source: 'voice',
    })

    answerQuestion(db, Q, 'Next Tuesday', deps)
    const view = buildInbox(load(db), [])
    expect(view.questions).toHaveLength(0)
    const done = new Map(view.done.map((d) => [d.suggestionId, d]))
    expect(done.get(S_RUN)).toMatchObject({
      viaQuestion: false,
      confirmed: true,
      bulletId: B2,
      snippet: '“start tracking water, ran 5k”',
      source: 'text',
    })
    expect(done.get(S_EVENT)?.bulletId).toBe(B1)
    expect(done.get(S_EVENT)).toMatchObject({ viaQuestion: true, confirmed: false })
    expect(done.get(S_EVENT)?.summary.done).toMatch(/^Dentist · .+ added$/)
    expect(view.groups[0]?.items.map((i) => i.id)).toEqual([S_MOOD])
  })

  test('yesterday’s items are not "today"; an empty Inbox says so', () => {
    const db = openTestDb()
    db.insert(suggestions)
      .values(
        row(
          S_RUN,
          B2,
          'activity',
          { name: 'Run' },
          { status: 'accepted', auto_applied: true, tier: 'auto', applied_at: T0 - 86_400_000 },
        ),
      )
      .run()
    const view = buildInbox(load(db), [])
    expect(view.done).toEqual([])
    expect(view.empty).toBe(true)
    expect(startOfDay(T0, TZ)).toBe(paris(15, 0))
  })
})

describe('retracting a decision inside the Undo window', () => {
  test('an unsent accept or dismiss is taken back: op gone, suggestion pending again', () => {
    const { db, deps } = seed()
    const original =
      db
        .select()
        .from(suggestions)
        .all()
        .find((s) => s.id === S_EVENT)?.payload ?? {}
    acceptSuggestion(db, S_EVENT, deps, { ...original, title: 'Dentist (moved)' })
    rejectSuggestion(db, S_MOOD, deps)
    expect(retractDecision(db, S_EVENT, original, T0)).toBe(true)
    expect(retractDecision(db, S_MOOD, {}, T0)).toBe(true)
    expect(db.select().from(outbox).all()).toEqual([])
    const rows = db.select().from(suggestions).all()
    expect(rows.find((s) => s.id === S_EVENT)).toMatchObject({
      status: 'pending',
      payload: original,
      resolved_at: null,
    })
    expect(buildInbox(load(db), []).pendingCount).toBe(3)
  })

  test('once sent there is nothing to retract', () => {
    const { db } = seed()
    expect(retractDecision(db, S_EVENT, {}, T0)).toBe(false)
  })
})

describe('a refused decision', () => {
  function refusingTransport(
    code: 'stale' | 'conflict',
  ): SyncTransport & { pulls: (string | undefined)[] } {
    const pulls: (string | undefined)[] = []
    const empty: PullResponse['changes'] = {
      bullets: [],
      suggestions: [],
      tasks: [],
      events: [],
      trackers: [],
      tracker_entries: [],
      activities: [],
      audio_attachments: [],
      transcripts: [],
      thoughts: [],
      questions: [],
    }
    return {
      pulls,
      async push(req: PushRequest): Promise<PushResponse> {
        return {
          results: req.ops.map((op) => ({
            op_id: op.op_id,
            status: 'rejected' as const,
            error: { code, message: 'changed since' },
          })),
          server_time: T0,
        }
      },
      async pull({ cursor }) {
        pulls.push(cursor)
        return { changes: empty, cursor: '42', has_more: false, server_time: T0 }
      },
      async audioStatus() {
        throw new Error('unused')
      },
      async uploadAudio() {
        throw new Error('unused')
      },
    }
  }

  test('is recorded with a calm notice, and the next pull starts from scratch', async () => {
    const { db, deps } = seed()
    setState(db, CURSOR_KEY, '17')
    acceptSuggestion(db, S_EVENT, deps)
    const transport = refusingTransport('stale')
    const client = createSyncClient({ db, transport: () => transport, now: () => T0 })
    await client.sync()

    expect(transport.pulls).toEqual([undefined]) // full pull, not from cursor 17
    expect(getState(db, CURSOR_KEY)).toBe('42')
    const [r] = listRejections(db)
    expect(r).toMatchObject({ type: 'suggestion.accept', suggestion_id: S_EVENT, code: 'stale' })
    const view = buildInbox(load(db), [])
    expect(view.notices.map((n) => n.text)).toEqual([
      "Couldn't add “Dentist”: things changed since it was suggested, so nothing was changed.",
    ])
    clearRejection(db, r?.key ?? '')
    expect(buildInbox(load(db), []).notices).toEqual([])
  })

  test('an Undo refused because the user edited the item says so', async () => {
    const { db, deps } = seed()
    undoSuggestion(db, S_RUN, deps)
    const transport = refusingTransport('conflict')
    await createSyncClient({ db, transport: () => transport, now: () => T0 }).sync()
    expect(buildInbox(load(db), []).notices[0]?.text).toBe(
      "“Run” stays as you left it: you changed it after it was added, so Undo won't overwrite your edit.",
    )
  })
})

describe('edit then accept', () => {
  const event = {
    target_kind: 'event' as const,
    operation: 'create' as const,
    target_id: null,
    payload: {
      title: 'Dentist',
      starts_at: paris(20, 15),
      ends_at: paris(20, 16),
      all_day: false,
      location: null,
      notes: null,
    },
  }

  test('moving an event keeps its length; a blank title is refused', () => {
    const form = editFormFor(event)
    expect(form).toEqual({ kind: 'event', title: 'Dentist', starts_at: paris(20, 15) })
    const moved = applyEdit(event, { kind: 'event', title: 'Dentist ', starts_at: paris(27, 10) })
    expect(moved).toEqual({
      ok: true,
      payload: {
        ...event.payload,
        title: 'Dentist',
        starts_at: paris(27, 10),
        ends_at: paris(27, 11),
      },
    })
    expect(applyEdit(event, { kind: 'event', title: ' ', starts_at: paris(27, 10) }).ok).toBe(false)
  })

  test('a reading must fit its tracker', () => {
    const entry = {
      target_kind: 'tracker_entry' as const,
      operation: 'append' as const,
      target_id: MOOD,
      payload: { tracker_id: MOOD, value: 3 },
    }
    const scale = { input_type: 'scale' as const, min: 1, max: 5 }
    expect(applyEdit(entry, { kind: 'tracker_entry', value: 4 }, scale)).toMatchObject({
      ok: true,
      payload: { value: 4 },
    })
    expect(applyEdit(entry, { kind: 'tracker_entry', value: 9 }, scale)).toEqual({
      ok: false,
      message: 'Pick a value from 1 to 5.',
    })
  })

  test('updates are not edited here; amounts parse leniently', () => {
    expect(
      editFormFor({
        target_kind: 'task',
        operation: 'update',
        target_id: TASK,
        payload: { status: 'done' },
      }),
    ).toBeNull()
    expect(parseNumber(' 5,5 ')).toBe(5.5)
    expect(parseNumber('5k')).toBeNull()
  })
})

describe('held decisions (the Undo window is real)', () => {
  const empty: PullResponse['changes'] = {
    bullets: [],
    suggestions: [],
    tasks: [],
    events: [],
    trackers: [],
    tracker_entries: [],
    activities: [],
    audio_attachments: [],
    transcripts: [],
    thoughts: [],
    questions: [],
  }
  function recordingTransport(opts: { onPush?: () => void } = {}) {
    const pushed: string[][] = []
    const transport: SyncTransport = {
      async push(req: PushRequest): Promise<PushResponse> {
        opts.onPush?.()
        pushed.push(req.ops.map((op) => op.type))
        return {
          results: req.ops.map((op) => ({ op_id: op.op_id, status: 'applied' as const })),
          server_time: T0,
        }
      },
      async pull() {
        return { changes: empty, cursor: '1', has_more: false, server_time: T0 }
      },
      async audioStatus() {
        throw new Error('unused')
      },
      async uploadAudio() {
        throw new Error('unused')
      },
    }
    return { transport, pushed }
  }

  test('a held op is not pushed while its window is open; other ops still go', async () => {
    const { db, deps } = seed()
    const clock = { now: T0 }
    expect(decideHeld(db, S_EVENT, 'dismissed', T0 + UNDO_WINDOW_MS, deps)).toBe(true)
    // Something else syncs meanwhile (a question answer, a capture): only that goes.
    captureBullet(db, { text: 'buy milk' }, deps)
    const { transport, pushed } = recordingTransport()
    const client = createSyncClient({ db, transport: () => transport, now: () => clock.now })
    await client.sync()
    expect(pushed).toEqual([['bullet.create']])
    expect(
      db
        .select()
        .from(outbox)
        .all()
        .map((r) => r.type),
    ).toEqual(['suggestion.reject'])

    // Undo inside the window still works, because the server never saw it.
    expect(retractDecision(db, S_EVENT, {}, T0)).toBe(true)
  })

  test('later ops about the same suggestion wait behind its held decision', async () => {
    const { db, deps } = seed()
    decideHeld(db, S_EVENT, 'accepted', T0 + UNDO_WINDOW_MS, deps)
    undoSuggestion(db, S_EVENT, deps) // e.g. Undo from another screen: must not overtake
    const { transport, pushed } = recordingTransport()
    await createSyncClient({ db, transport: () => transport, now: () => T0 }).sync()
    expect(pushed).toEqual([])
  })

  test('released when the window closes, or once the hold runs out by itself', async () => {
    const { db, deps } = seed()
    decideHeld(db, S_EVENT, 'accepted', T0 + UNDO_WINDOW_MS, deps)
    decideHeld(db, S_MOOD, 'dismissed', T0 + UNDO_WINDOW_MS, deps)
    const clock = { now: T0 }
    const { transport, pushed } = recordingTransport()
    const client = createSyncClient({ db, transport: () => transport, now: () => clock.now })

    releaseHolds(db, [S_EVENT])
    await client.sync()
    expect(pushed).toEqual([['suggestion.accept']])

    // The app died before releasing S_MOOD: after the window it goes anyway.
    clock.now = T0 + UNDO_WINDOW_MS
    await client.sync()
    expect(pushed).toEqual([['suggestion.accept'], ['suggestion.reject']])
    expect(db.select().from(outbox).all()).toEqual([])
  })

  test('an op being pushed right now is not retracted', async () => {
    const { db, deps } = seed()
    decideHeld(db, S_MOOD, 'dismissed', T0 + UNDO_WINDOW_MS, deps)
    releaseHolds(db)
    let retracted: boolean | null = null
    const { transport } = recordingTransport({
      // Undo tapped while the push is in flight.
      onPush: () => (retracted = retractDecision(db, S_MOOD, {}, T0)),
    })
    await createSyncClient({ db, transport: () => transport, now: () => T0 }).sync()
    expect(retracted).toBe(false)
    expect(
      db
        .select()
        .from(suggestions)
        .all()
        .find((s) => s.id === S_MOOD)?.status,
    ).toBe('rejected')
  })

  test('a second tap on a decided suggestion does nothing', () => {
    const { db, deps } = seed()
    expect(decideHeld(db, S_EVENT, 'accepted', T0 + 1, deps)).toBe(true)
    expect(decideHeld(db, S_EVENT, 'accepted', T0 + 1, deps, { title: 'x' })).toBe(false)
    expect(db.select().from(outbox).all()).toHaveLength(1)
  })
})

describe('refusal scope and notices', () => {
  const rejecting = (pulls: (string | undefined)[]): SyncTransport => ({
    async push(req: PushRequest): Promise<PushResponse> {
      return {
        results: req.ops.map((op) => ({
          op_id: op.op_id,
          status: 'rejected' as const,
          error: { code: 'invalid' as const, message: 'nope' },
        })),
        server_time: T0,
      }
    },
    async pull({ cursor }) {
      pulls.push(cursor)
      return {
        changes: {
          bullets: [],
          suggestions: [],
          tasks: [],
          events: [],
          trackers: [],
          tracker_entries: [],
          activities: [],
          audio_attachments: [],
          transcripts: [],
          thoughts: [],
          questions: [],
        },
        cursor: '9',
        has_more: false,
        server_time: T0,
      }
    },
    async audioStatus() {
      throw new Error('unused')
    },
    async uploadAudio() {
      throw new Error('unused')
    },
  })

  test('a refused dismiss forces a full pull but leaves no record', async () => {
    const { db, deps } = seed()
    setState(db, CURSOR_KEY, '5')
    rejectSuggestion(db, S_MOOD, deps)
    const pulls: (string | undefined)[] = []
    await createSyncClient({ db, transport: () => rejecting(pulls), now: () => T0 }).sync()
    expect(pulls).toEqual([undefined])
    expect(listRejections(db)).toEqual([])
  })

  test('a refused bullet op keeps the incremental pull and leaves no record', async () => {
    const { db, deps } = seed()
    setState(db, CURSOR_KEY, '5')
    captureBullet(db, { text: 'x' }, deps)
    const pulls: (string | undefined)[] = []
    await createSyncClient({ db, transport: () => rejecting(pulls), now: () => T0 }).sync()
    expect(pulls).toEqual(['5'])
    expect(listRejections(db)).toEqual([])
  })

  test('notice wording', () => {
    const r = (
      type: 'suggestion.undo' | 'question.answer' | 'suggestion.reject',
      code = 'invalid' as const,
    ) => ({
      key: 'rejection:x',
      type,
      suggestion_id: null,
      question_id: null,
      code,
      message: '',
      at: T0,
    })
    expect(noticeText(r('question.answer'), new Map(), ctx())).toBe(
      'Your answer arrived after that was already decided, so nothing changed.',
    )
    expect(noticeText(r('suggestion.undo'), new Map(), ctx())).toBe(
      "Couldn't undo that; it's still there, unchanged.",
    )
    expect(noticeText(r('suggestion.reject'), new Map(), ctx())).toBeNull()
  })

  test('startOfDay holds on DST days', () => {
    // Clocks go back in Paris on Sun 25 Oct 2026 and forward on Sun 29 Mar 2026.
    expect(startOfDay(Date.UTC(2026, 9, 25, 12), TZ)).toBe(Date.UTC(2026, 9, 24, 22))
    expect(startOfDay(Date.UTC(2026, 2, 29, 12), TZ)).toBe(Date.UTC(2026, 2, 28, 23))
  })
})
