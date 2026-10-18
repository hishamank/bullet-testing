import { pushOpSchema, type PullResponse } from '@bullet/core'
import { describe, expect, test } from 'vite-plus/test'
import { openTestDb, testDeps } from '../test/db'
import { captureBullet, deleteBullet, dismissQuestion, reclassifyThought } from './local'
import { applyPull } from './mirror'
import { listOpenQuestions, listThoughts } from './queries'
import { outbox, questions, thoughts } from './schema'

const OWNER = '00000000-0000-4000-8000-0000000000aa'
const B = '00000000-0000-4000-8000-000000000b01'
const T1 = '00000000-0000-4000-8000-000000000a01'
const T2 = '00000000-0000-4000-8000-000000000a02'
const Q1 = '00000000-0000-4000-8000-000000000c01'
const base = { owner_id: OWNER, created_at: 1, updated_at: 1, state: 'active' as const }

const page = (over: Partial<PullResponse['changes']> = {}): PullResponse => ({
  cursor: '1',
  has_more: false,
  server_time: 1,
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
    thoughts: [
      {
        ...base,
        id: T2,
        source_bullet_id: B,
        position: 1,
        text: 'call the landlord',
        span: null,
        kind: 'task',
        kind_source: 'engine',
        resolved_at: null,
        resolved_by_bullet_id: null,
      },
      {
        ...base,
        id: T1,
        source_bullet_id: B,
        position: 0,
        text: 'worried about rent',
        span: { start: 0, end: 18 },
        kind: 'worry',
        kind_source: 'engine',
        resolved_at: null,
        resolved_by_bullet_id: null,
      },
    ],
    questions: [
      {
        ...base,
        id: Q1,
        source_bullet_id: B,
        source_thought_id: T2,
        suggestion_id: null,
        kind: 'clarifying',
        topic: 'date',
        text: 'Which Thursday?',
        options: ['Today', 'Next Thursday'],
        status: 'open',
        answer_bullet_id: null,
        answer_option: null,
        resolved_at: null,
      },
    ],
    ...over,
  },
})

describe('thoughts and questions on the phone', () => {
  test('a pull brings thoughts (in order, with spans) and open questions', () => {
    const db = openTestDb()
    applyPull(db, page())
    expect(listThoughts(db, B).map((t) => [t.position, t.kind, t.span_start, t.span_end])).toEqual([
      [0, 'worry', 0, 18],
      [1, 'task', null, null],
    ])
    expect(listOpenQuestions(db).map((q) => q.text)).toEqual(['Which Thursday?'])
  })

  test('re-classify is local-first and survives a pull until acknowledged', () => {
    const db = openTestDb()
    applyPull(db, page())
    reclassifyThought(db, T1, 'to_check', testDeps())
    const op = db.select().from(outbox).get()?.op
    expect(pushOpSchema.safeParse(op).success).toBe(true)
    applyPull(db, page()) // server still says worry
    expect(listThoughts(db, B)[0]).toMatchObject({ kind: 'to_check', kind_source: 'user' })
  })

  test('dismiss, and answering by capture', () => {
    const db = openTestDb()
    const deps = testDeps()
    applyPull(db, page())
    dismissQuestion(db, Q1, deps)
    expect(listOpenQuestions(db)).toEqual([])

    const db2 = openTestDb()
    applyPull(db2, page())
    const answer = captureBullet(db2, { text: 'next week', answersQuestionId: Q1 }, deps)
    expect(db2.select().from(questions).get()).toMatchObject({
      status: 'answered',
      answer_bullet_id: answer,
    })
    expect(db2.select().from(outbox).get()?.op).toMatchObject({
      bullet: { answers_question_id: Q1 },
    })
  })

  test('deleting a capture hides its thoughts and questions', () => {
    const db = openTestDb()
    applyPull(db, page())
    deleteBullet(db, B, 'keep_extractions', testDeps())
    expect(
      db
        .select()
        .from(thoughts)
        .all()
        .every((t) => t.state === 'deleted'),
    ).toBe(true)
    expect(listOpenQuestions(db)).toEqual([])
  })
})
