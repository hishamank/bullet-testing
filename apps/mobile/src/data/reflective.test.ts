import {
  type PullResponse,
  pushOpSchema,
  type Question,
  REFLECTIVE_CAPS,
  type SyncedThought,
} from '@bullet/core'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { describe, expect, test } from 'vite-plus/test'
import { inboxCount } from '../features/capture/counts'
import { findPinned } from '../features/capture/pinned'
import { createSyncClient } from '../sync/client'
import { FakeServer } from '../test/fake-server'
import { openTestDb, T0, testDeps } from '../test/db'
import { migrate } from './db'
import {
  answerQuestion,
  captureBullet,
  dismissQuestion,
  pickEvergreen,
  snoozeQuestion,
} from './local'
import { applyPull } from './mirror'
import { MIGRATIONS } from './migrations.gen'
import { listAnsweredReflective, listOpenQuestions, listQuestionsToThinkAbout } from './queries'
import { outbox, questions, schema, thoughts } from './schema'

const OWNER = '00000000-0000-4000-8000-0000000000aa'
const B = '00000000-0000-4000-8000-000000000b01'
const WORRY = '00000000-0000-4000-8000-000000000a01'
const Q_CLARIFY = '00000000-0000-4000-8000-000000000c01'
const Q_REFLECT = '00000000-0000-4000-8000-000000000c02'
const Q_LOOP = '00000000-0000-4000-8000-000000000c03'
const DAY = 24 * 60 * 60 * 1000
const base = { owner_id: OWNER, created_at: T0, updated_at: T0, state: 'active' as const }

const question = (over: Partial<Question>): Question => ({
  ...base,
  id: Q_CLARIFY,
  source_bullet_id: B,
  source_thought_id: null,
  suggestion_id: null,
  kind: 'clarifying',
  origin: 'capture',
  topic: 'other',
  text: 'Which bank?',
  options: ['BLC', 'Bemo'],
  status: 'open',
  answer_bullet_id: null,
  answer_option: null,
  resolved_at: null,
  snoozed_until: null,
  snooze_count: 0,
  template_id: null,
  ...over,
})

const worry: SyncedThought = {
  ...base,
  id: WORRY,
  source_bullet_id: B,
  position: 0,
  text: 'dreading the meeting with Karim',
  span: null,
  kind: 'worry',
  kind_source: 'engine',
  resolved_at: null,
  resolved_by_bullet_id: null,
  never_ask: false,
}

const page = (over: Partial<PullResponse['changes']> = {}, cursor = '1'): PullResponse => ({
  cursor,
  has_more: false,
  server_time: T0,
  changes: {
    bullets: [
      {
        ...base,
        id: B,
        text: 'dreading the meeting with Karim. Which bank?',
        captured_at: T0,
        timezone: 'Europe/Paris',
        source: 'text',
        text_edited_by_user: false,
        text_from_draft: false,
        answers_question_id: null,
        resolves_thought_id: null,
        processing: {
          status: 'processed',
          attempts: 1,
          error: null,
          next_retry_at: null,
          updated_at: T0,
        },
      },
    ],
    suggestions: [],
    tasks: [],
    events: [],
    trackers: [],
    tracker_entries: [],
    activities: [],
    audio_attachments: [],
    transcripts: [],
    thoughts: [worry],
    questions: [
      question({}),
      question({
        id: Q_REFLECT,
        kind: 'reflective',
        topic: 'other',
        options: [],
        source_thought_id: WORRY,
        text: 'You wrote «dreading the meeting». What about it feels heavy?',
        created_at: T0 + 1,
      }),
    ],
    ...over,
  },
})

function seeded() {
  const db = openTestDb()
  const deps = testDeps()
  applyPull(db, page())
  const ops = () => db.select().from(outbox).all()
  const q = (id: string) => db.select().from(questions).where(eq(questions.id, id)).get()
  return { db, deps, ops, q }
}

describe('Inbox questions: To clarify / To think about', () => {
  test('reflective questions are pulled with their fields, never in the badge or To clarify', () => {
    const { db, q } = seeded()
    expect(q(Q_REFLECT)).toMatchObject({ kind: 'reflective', origin: 'capture', snooze_count: 0 })
    expect(listOpenQuestions(db).map((x) => x.id)).toEqual([Q_CLARIFY])
    expect(inboxCount(db)).toBe(1)
    const think = listQuestionsToThinkAbout(db, T0)
    expect(think.map((v) => v.question.id)).toEqual([Q_REFLECT])
    expect(think[0]?.source?.id).toBe(B)
  })

  test('tapping an option is not how a reflective question is answered', () => {
    const { db, deps } = seeded()
    expect(() => answerQuestion(db, Q_REFLECT, 'Yes', deps)).toThrow(/capture/)
  })
})

describe('Later', () => {
  test('hides it for 7 days; a second Later dismisses it quietly', () => {
    const { db, deps, ops, q } = seeded()
    snoozeQuestion(db, Q_REFLECT, deps)
    expect(q(Q_REFLECT)).toMatchObject({
      status: 'snoozed',
      snooze_count: 1,
      snoozed_until: T0 + REFLECTIVE_CAPS.snoozeMs,
    })
    expect(listQuestionsToThinkAbout(db, T0 + 7 * DAY - 1)).toHaveLength(0)
    expect(listQuestionsToThinkAbout(db, T0 + 7 * DAY)).toHaveLength(1)
    snoozeQuestion(db, Q_REFLECT, deps)
    expect(q(Q_REFLECT)).toMatchObject({ status: 'dismissed', snooze_count: 2 })
    expect(listQuestionsToThinkAbout(db, T0 + 8 * DAY)).toHaveLength(0)
    // Quietly: not "Not this one".
    expect(db.select().from(thoughts).get()?.never_ask).toBe(false)
    expect(ops().map((o) => [o.type, o.question_id])).toEqual([
      ['question.snooze', Q_REFLECT],
      ['question.snooze', Q_REFLECT],
    ])
    for (const o of ops()) expect(pushOpSchema.safeParse(o.op).success).toBe(true)
  })

  test('only for reflective questions', () => {
    const { db, deps } = seeded()
    expect(() => snoozeQuestion(db, Q_CLARIFY, deps)).toThrow()
  })
})

describe('Not this one', () => {
  test('marks the thought never-ask at once, and a pull before the ack keeps it', () => {
    const { db, deps, ops, q } = seeded()
    dismissQuestion(db, Q_REFLECT, deps)
    expect(q(Q_REFLECT)?.status).toBe('dismissed')
    expect(db.select().from(thoughts).get()?.never_ask).toBe(true)
    expect(ops()[0]).toMatchObject({ type: 'question.dismiss', thought_id: WORRY })
    applyPull(db, page({ bullets: [], questions: [] }, '2'))
    expect(db.select().from(thoughts).get()?.never_ask).toBe(true)
  })

  test('on a clarifying question it touches no thought', () => {
    const { db, deps, ops } = seeded()
    dismissQuestion(db, Q_CLARIFY, deps)
    expect(ops()[0]?.thought_id).toBeNull()
  })
})

describe('evergreen picks', () => {
  test('created on the phone at once, up to one over the open cap', () => {
    const { db, deps, ops, q } = seeded()
    applyPull(
      db,
      page(
        {
          bullets: [],
          questions: [
            question({ id: Q_LOOP, kind: 'reflective', origin: 'open_loop', options: [] }),
            question({
              id: '00000000-0000-4000-8000-000000000c04',
              kind: 'reflective',
              status: 'snoozed',
              snoozed_until: T0 + DAY,
              options: [],
            }),
          ],
        },
        '2',
      ),
    )
    const id = pickEvergreen(db, 'enough', deps)
    expect(q(id)).toMatchObject({
      kind: 'reflective',
      origin: 'evergreen',
      template_id: 'enough',
      source_bullet_id: null,
      text: 'What would make this week feel like enough?',
      status: 'open',
    })
    expect(ops().at(-1)).toMatchObject({ type: 'question.pick_evergreen', question_id: id })
    expect(listQuestionsToThinkAbout(db, T0).find((v) => v.question.id === id)?.source).toBeNull()
    // 3 open/snoozed + this pick = 4: no more.
    expect(() => pickEvergreen(db, 'surprised', deps)).toThrow(/enough questions/)
    expect(() => pickEvergreen(db, 'nope', deps)).toThrow(/unknown/)
  })

  test('a pick the server refuses disappears from the phone', async () => {
    const db = openTestDb()
    const deps = testDeps()
    const server = new FakeServer()
    const push = server.push.bind(server)
    server.push = async (req) => {
      const res = await push(req)
      return {
        ...res,
        results: res.results.map((r, i) =>
          req.ops[i]?.type === 'question.pick_evergreen'
            ? { op_id: r.op_id, status: 'rejected', error: { code: 'conflict', message: 'full' } }
            : r,
        ),
      }
    }
    const id = pickEvergreen(db, 'enough', deps)
    await createSyncClient({ db, transport: () => server }).sync()
    expect(db.select().from(questions).where(eq(questions.id, id)).get()?.state).toBe('deleted')
    expect(listQuestionsToThinkAbout(db, T0)).toHaveLength(0)
  })
})

describe('Journal about it', () => {
  test('an offline answer syncs as a capture; more answers allowed; Answered · N', async () => {
    const { db, deps, q } = seeded()
    // Offline: the answer is saved on the phone, the question answered at once.
    const a1 = captureBullet(
      db,
      { text: 'mostly the uncertainty', answersQuestionId: Q_REFLECT },
      deps,
    )
    expect(q(Q_REFLECT)).toMatchObject({ status: 'answered', answer_bullet_id: a1 })
    expect(findPinned(db, { question: Q_REFLECT })?.kind).toBe('question')
    deps.clock.now += 60_000
    const a2 = captureBullet(
      db,
      { text: 'and Karim never replies', answersQuestionId: Q_REFLECT },
      deps,
    )
    expect(q(Q_REFLECT)?.answer_bullet_id).toBe(a1)

    // Back online: both go to the server as ordinary captures pointing at the question.
    const server = new FakeServer()
    const outcome = await createSyncClient({ db, transport: () => server }).sync()
    expect(outcome).toMatchObject({ ok: true, pushed: 2 })
    expect(
      server.received.map((op) =>
        op.type === 'bullet.create' ? [op.bullet.id, op.bullet.answers_question_id] : null,
      ),
    ).toEqual([
      [a1, Q_REFLECT],
      [a2, Q_REFLECT],
    ])

    // The server's answer: the capture split and extracted, the question answered.
    applyPull(
      db,
      page(
        {
          bullets: [],
          thoughts: [
            {
              ...worry,
              id: '00000000-0000-4000-8000-000000000a09',
              source_bullet_id: a1,
              text: 'mostly the uncertainty',
              kind: 'note',
            },
          ],
          questions: [
            question({
              id: Q_REFLECT,
              kind: 'reflective',
              options: [],
              status: 'answered',
              answer_bullet_id: a1,
              resolved_at: T0 + 5,
            }),
          ],
        },
        '9',
      ),
    )
    const answered = listAnsweredReflective(db)
    expect(answered.count).toBe(1)
    expect(answered.items[0]?.answers.map((a) => a.id)).toEqual([a1, a2])
    expect(answered.items[0]?.source?.id).toBe(B)
    expect(listQuestionsToThinkAbout(db, T0)).toHaveLength(0)
  })
})

test('migration 0006 keeps every question, read as clarifying', () => {
  const sqlite = new Database(':memory:')
  const db = drizzle(sqlite, { schema })
  const before = MIGRATIONS.filter((m) => m.tag < '0006')
  migrate(db, before)
  sqlite.exec(`INSERT INTO questions (id, created_at, updated_at, source_bullet_id, kind, topic,
    text, options, status) VALUES ('q', 1, 1, 'b', 'clarifying', 'date', 'Which Thursday?',
    '["Today"]', 'open')`)
  migrate(db)
  expect(db.select().from(questions).all()).toMatchObject([
    {
      id: 'q',
      kind: 'clarifying',
      origin: 'capture',
      snooze_count: 0,
      template_id: null,
      options: ['Today'],
    },
  ])
})
