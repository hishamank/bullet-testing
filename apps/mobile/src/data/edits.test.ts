import { type PullResponse, pushOpSchema } from '@bullet/core'
import { zonedToEpoch } from '@bullet/engine'
import { describe, expect, test } from 'vite-plus/test'
import { openTestDb, T0, testDeps } from '../test/db'
import {
  answerQuestion,
  captureBullet,
  captureVoiceBullet,
  deleteEvent,
  deleteTask,
  deleteTrackerEntry,
  resolveThought,
  unresolveThought,
  updateEvent,
  updateTask,
  updateTrackerEntry,
} from './local'
import { applyPull } from './mirror'
import { listOpenLoops } from './queries'
import { events, outbox, questions, suggestions, tasks, thoughts, trackerEntries } from './schema'

const OWNER = '00000000-0000-4000-8000-0000000000aa'
const B = '00000000-0000-4000-8000-000000000b01'
const TASK = '00000000-0000-4000-8000-000000000d01'
const EVENT = '00000000-0000-4000-8000-000000000d02'
const TRACKER = '00000000-0000-4000-8000-000000000d03'
const ENTRY = '00000000-0000-4000-8000-000000000d04'
const LOOP = '00000000-0000-4000-8000-000000000a01'
const WORRY = '00000000-0000-4000-8000-000000000a02'
const S_EVENT = '00000000-0000-4000-8000-000000000e01'
const S_TRACKER = '00000000-0000-4000-8000-000000000e02'
const Q_DATE = '00000000-0000-4000-8000-000000000c01'
const Q_TRACKER = '00000000-0000-4000-8000-000000000c02'
const base = { owner_id: OWNER, created_at: 1, updated_at: 1, state: 'active' as const }
const prov = { source_bullet_id: B, source_thought_id: null, user_edited_at: null }
const paris = (day: number, hour: number) =>
  zonedToEpoch({ year: 2026, month: 10, day, hour, minute: 0 }, 'Europe/Paris')

const suggestion = (id: string, target_kind: 'event' | 'tracker', payload: object) => ({
  ...base,
  id,
  source_bullet_id: B,
  source_thought_id: null,
  target_kind,
  operation: 'create' as const,
  target_id: null,
  payload: payload as Record<string, unknown>,
  confidence: 0.8,
  tier: 'suggest' as const,
  status: 'pending' as const,
  resolved_at: null,
  applied_entity_id: null,
  applied_at: null,
  auto_applied: false,
})

const question = (
  id: string,
  topic: 'date' | 'new_tracker',
  suggestion_id: string,
  options: string[],
) => ({
  ...base,
  id,
  source_bullet_id: B,
  source_thought_id: null,
  suggestion_id,
  kind: 'clarifying' as const,
  topic,
  text: '?',
  options,
  status: 'open' as const,
  answer_bullet_id: null,
  answer_option: null,
  origin: 'capture' as const,
  snoozed_until: null,
  snooze_count: 0,
  template_id: null,
  resolved_at: null,
})

const thought = (id: string, kind: 'to_check' | 'worry', position: number) => ({
  ...base,
  id,
  source_bullet_id: B,
  position,
  text: kind,
  span: null,
  kind,
  kind_source: 'engine' as const,
  resolved_at: null,
  resolved_by_bullet_id: null,
  never_ask: false,
})

const page = (over: Partial<PullResponse['changes']> = {}, cursor = '1'): PullResponse => ({
  cursor,
  has_more: false,
  server_time: 1,
  changes: {
    bullets: [
      {
        ...base,
        id: B,
        text: 'dentist thursday 3pm, slept 6 hours',
        captured_at: T0,
        timezone: 'Europe/Paris',
        source: 'text',
        text_edited_by_user: false,
        text_from_draft: false,
        answers_question_id: null,
        resolves_thought_id: null,
        processing: {
          status: 'needs_review',
          attempts: 1,
          error: null,
          next_retry_at: null,
          updated_at: 1,
        },
      },
    ],
    suggestions: [
      suggestion(S_EVENT, 'event', {
        title: 'Dentist',
        starts_at: paris(15, 15),
        ends_at: paris(15, 16),
        all_day: false,
        location: null,
        notes: null,
      }),
      suggestion(S_TRACKER, 'tracker', { name: 'sleep', input_type: 'number' }),
    ],
    tasks: [
      {
        ...base,
        ...prov,
        id: TASK,
        status: 'todo',
        title: 'Call the landlord',
        notes: null,
        due_at: null,
        priority: null,
      },
    ],
    events: [
      {
        ...base,
        ...prov,
        id: EVENT,
        title: 'Dinner',
        starts_at: paris(16, 20),
        ends_at: paris(16, 22),
        all_day: false,
        location: null,
        notes: null,
      },
    ],
    trackers: [
      {
        ...base,
        source_bullet_id: null,
        source_thought_id: null,
        id: TRACKER,
        name: 'mood',
        input_type: 'scale',
        config: { input_type: 'scale', min: 1, max: 5 },
      },
    ],
    tracker_entries: [
      { ...base, ...prov, id: ENTRY, tracker_id: TRACKER, value: 2, logged_at: T0 },
    ],
    activities: [],
    audio_attachments: [],
    transcripts: [],
    thoughts: [thought(LOOP, 'to_check', 0), thought(WORRY, 'worry', 1)],
    questions: [
      question(Q_DATE, 'date', S_EVENT, ['Today', 'Next Thursday']),
      question(Q_TRACKER, 'new_tracker', S_TRACKER, ['Yes', 'No']),
    ],
    ...over,
  },
})

function seeded() {
  const db = openTestDb()
  applyPull(db, page())
  return db
}

const ops = (db: ReturnType<typeof openTestDb>) => db.select().from(outbox).all()

describe('light manual editing on the phone', () => {
  test('a task edit is written with its op, marked user-edited, and survives a pull', () => {
    const db = seeded()
    const deps = testDeps()
    updateTask(db, TASK, { status: 'done', due_at: paris(17, 9) }, deps)
    expect(db.select().from(tasks).get()).toMatchObject({
      status: 'done',
      due_at: paris(17, 9),
      user_edited_at: T0,
    })
    const [op] = ops(db)
    expect(op).toMatchObject({ type: 'task.update', entity_id: TASK })
    expect(pushOpSchema.parse(op?.op)).toMatchObject({ task_id: TASK, patch: { status: 'done' } })

    // The server's older copy doesn't undo the local edit while the op is unsent…
    applyPull(db, page({}, '2'))
    expect(db.select().from(tasks).get()?.status).toBe('done')
    // …and once acknowledged, the server's version is taken again.
    db.delete(outbox).run()
    applyPull(db, page({}, '3'))
    expect(db.select().from(tasks).get()?.status).toBe('todo')
  })

  test('invalid edits throw and write nothing', () => {
    const db = seeded()
    const deps = testDeps()
    expect(() => updateTask(db, TASK, {}, deps)).toThrow()
    expect(() => updateEvent(db, EVENT, { ends_at: paris(16, 19) }, deps)).toThrow(/end before/)
    expect(() => updateTrackerEntry(db, ENTRY, 9, deps)).toThrow(/does not fit/)
    expect(() =>
      updateTask(db, '00000000-0000-4000-8000-00000000ffff', { title: 'x' }, deps),
    ).toThrow()
    expect(ops(db)).toHaveLength(0)
    expect(db.select().from(trackerEntries).get()?.value).toBe(2)
  })

  test('move an event, correct a reading, and soft-delete each kind', () => {
    const db = seeded()
    const deps = testDeps()
    updateEvent(db, EVENT, { starts_at: paris(16, 19), title: 'Early dinner' }, deps)
    updateTrackerEntry(db, ENTRY, 4, deps)
    expect(db.select().from(events).get()).toMatchObject({
      title: 'Early dinner',
      starts_at: paris(16, 19),
    })
    expect(db.select().from(trackerEntries).get()?.value).toBe(4)

    deleteTask(db, TASK, deps)
    deleteEvent(db, EVENT, deps)
    deleteTrackerEntry(db, ENTRY, deps)
    for (const table of [tasks, events, trackerEntries]) {
      expect(db.select().from(table).get()).toMatchObject({ state: 'deleted', user_edited_at: T0 })
    }
    expect(ops(db).map((o) => o.type)).toEqual([
      'event.update',
      'tracker_entry.update',
      'task.delete',
      'event.delete',
      'tracker_entry.delete',
    ])
    for (const o of ops(db)) expect(pushOpSchema.safeParse(o.op).success, o.type).toBe(true)
  })
})

describe('open loops on the phone', () => {
  test('resolve / unresolve a to_check thought; a worry is not an open loop', () => {
    const db = seeded()
    const deps = testDeps()
    resolveThought(db, LOOP, deps)
    const loop = () =>
      db
        .select()
        .from(thoughts)
        .all()
        .find((t) => t.id === LOOP)
    expect(loop()?.resolved_at).toBe(T0)
    expect(() => resolveThought(db, WORRY, deps)).toThrow(/not an open loop/)
    // Pending: a pull doesn't re-open it.
    applyPull(db, page({}, '2'))
    expect(loop()?.resolved_at).toBe(T0)
    unresolveThought(db, LOOP, deps)
    expect(loop()?.resolved_at).toBeNull()
    expect(listOpenLoops(db).map((t) => t.id)).toEqual([LOOP])
    expect(ops(db).map((o) => o.type)).toEqual(['thought.resolve', 'thought.unresolve'])
  })

  test('a capture "with a note" resolves the thought at once and carries the link', () => {
    const db = seeded()
    const id = captureBullet(
      db,
      { text: 'it expires in 2031', resolvesThoughtId: LOOP },
      testDeps(),
    )
    expect(
      db
        .select()
        .from(thoughts)
        .all()
        .find((t) => t.id === LOOP),
    ).toMatchObject({
      resolved_at: T0,
      resolved_by_bullet_id: id,
    })
    const [op] = ops(db)
    expect(pushOpSchema.parse(op?.op)).toMatchObject({ bullet: { id, resolves_thought_id: LOOP } })
  })

  test('a voice answer links like a typed one: question answered, loop closed, op carries both', () => {
    const db = seeded()
    const id = captureVoiceBullet(
      db,
      {
        text: 'next week sometime',
        textEditedByUser: false,
        answersQuestionId: Q_DATE,
        resolvesThoughtId: LOOP,
        audio: {
          localPath: 'file:///rec/a.wav',
          mimeType: 'audio/wav',
          durationMs: 2000,
          sizeBytes: 64_044,
          sha256: null,
        },
        draft: { text: 'next week sometime', engine: 'apple-sfspeech', model: null, languages: [] },
      },
      testDeps(),
    )
    expect(
      db
        .select()
        .from(questions)
        .all()
        .find((q) => q.id === Q_DATE),
    ).toMatchObject({
      status: 'answered',
      answer_bullet_id: id,
    })
    expect(
      db
        .select()
        .from(thoughts)
        .all()
        .find((t) => t.id === LOOP),
    ).toMatchObject({
      resolved_by_bullet_id: id,
    })
    const [op] = ops(db)
    expect(pushOpSchema.parse(op?.op)).toMatchObject({
      bullet: { id, source: 'voice', answers_question_id: Q_DATE, resolves_thought_id: LOOP },
    })
  })
})

describe('answering a question by tapping an option', () => {
  test('date: the event suggestion moves to that day (keeping its time) and is accepted', () => {
    const db = seeded()
    answerQuestion(db, Q_DATE, 'Next Thursday', testDeps())
    const s = db
      .select()
      .from(suggestions)
      .all()
      .find((x) => x.id === S_EVENT)
    expect(s).toMatchObject({ status: 'edited' })
    expect(s?.payload).toMatchObject({ starts_at: paris(22, 15), ends_at: paris(22, 16) })
    expect(
      db
        .select()
        .from(questions)
        .all()
        .find((q) => q.id === Q_DATE),
    ).toMatchObject({
      status: 'answered',
      answer_option: 'Next Thursday',
    })
    const [op] = ops(db)
    expect(op).toMatchObject({ question_id: Q_DATE, suggestion_id: S_EVENT })
    expect(pushOpSchema.parse(op?.op)).toMatchObject({
      type: 'question.answer',
      option: 'Next Thursday',
    })
  })

  test('new tracker: Yes accepts, No dismisses; an option not offered throws', () => {
    const yes = seeded()
    answerQuestion(yes, Q_TRACKER, 'Yes', testDeps())
    expect(
      yes
        .select()
        .from(suggestions)
        .all()
        .find((x) => x.id === S_TRACKER)?.status,
    ).toBe('accepted')
    const no = seeded()
    answerQuestion(no, Q_TRACKER, 'No', testDeps())
    expect(
      no
        .select()
        .from(suggestions)
        .all()
        .find((x) => x.id === S_TRACKER)?.status,
    ).toBe('rejected')
    expect(() => answerQuestion(no, Q_DATE, 'Tomorrow', testDeps())).toThrow(/not an option/)
  })
})
