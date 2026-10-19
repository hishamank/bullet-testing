import { EVERGREEN_QUESTIONS } from '@bullet/core'
import { describe, expect, test } from 'vite-plus/test'
import { captureBullet, dismissQuestion, pickEvergreen, snoozeQuestion } from '../../data/local'
import { listRejections, recordRejection } from '../../data/rejections'
import { questions } from '../../data/schema'
import { openTestDb, T0, testDeps } from '../../test/db'
import { inboxCount } from '../capture/counts'
import { findPinned } from '../capture/pinned'
import { loadInboxRows, noticeText, summaryContext } from '../inbox/model'
import { loadCaptureDetail } from '../journal/capture'
import { listCaptureCards } from '../journal/stream'
import {
  answersAbout,
  daysAgo,
  evergreenChoices,
  loadThinkView,
  PICK_REFUSED_TEXT,
  questionSourceLine,
  thinkingAboutLabel,
} from './model'

// All sample content is made up. T0 is Thursday 15 Oct 2026, 09:12 in Paris.
const DAY = 24 * 60 * 60 * 1000
const TZ = 'Europe/Paris'

type QuestionInsert = typeof questions.$inferInsert

function reflective(over: Partial<QuestionInsert> & { id: string }): QuestionInsert {
  return {
    created_at: T0,
    updated_at: T0,
    source_bullet_id: null,
    kind: 'reflective',
    origin: 'capture',
    topic: 'other',
    text: 'What about it stays with you?',
    options: [],
    status: 'open',
    ...over,
  }
}

/** A voice capture with a reflective question, a week-old open loop's question, an evergreen one. */
function seeded() {
  const db = openTestDb()
  const deps = testDeps()
  deps.clock.now = T0 - 7 * DAY
  const loopCapture = captureBullet(db, { text: 'check if the bike lock still works' }, deps)
  deps.clock.now = T0
  const worry = captureBullet(
    db,
    { text: 'nervous about the pottery class on Saturday', source: 'voice' },
    deps,
  )
  db.insert(questions)
    .values([
      reflective({
        id: 'q-worry',
        source_bullet_id: worry,
        text: 'You said «nervous about the pottery class». What part of it feels big?',
      }),
      reflective({
        id: 'q-loop',
        origin: 'open_loop',
        source_bullet_id: loopCapture,
        text: 'Still on your mind? «check if the bike lock still works»',
        created_at: T0 + 1,
      }),
      reflective({
        id: 'q-evergreen',
        origin: 'evergreen',
        template_id: 'surprised',
        text: 'What surprised you this week?',
        created_at: T0 + 2,
      }),
    ])
    .run()
  return { db, deps, worry, loopCapture }
}

describe('To think about', () => {
  test('each card says where it came from; evergreen ones say nothing', () => {
    const { db, worry, loopCapture } = seeded()
    const view = loadThinkView(db, T0 + 60_000)
    expect(view.toThink).toEqual([
      {
        id: 'q-worry',
        text: 'You said «nervous about the pottery class». What part of it feels big?',
        origin: 'capture',
        sourceLine: 'From your voice note, today 09:12',
        sourceBulletId: worry,
      },
      {
        id: 'q-loop',
        text: 'Still on your mind? «check if the bike lock still works»',
        origin: 'open_loop',
        sourceLine: 'From an open loop, 7 days ago',
        sourceBulletId: loopCapture,
      },
      {
        id: 'q-evergreen',
        text: 'What surprised you this week?',
        origin: 'evergreen',
        sourceLine: null,
        sourceBulletId: null,
      },
    ])
    expect(view.answered).toEqual([])
  })

  test('never in the badge; Later hides one, Not this one removes one', () => {
    const { db, deps } = seeded()
    expect(inboxCount(db)).toBe(0)
    snoozeQuestion(db, 'q-loop', deps)
    dismissQuestion(db, 'q-evergreen', deps)
    expect(loadThinkView(db, T0 + 1).toThink.map((q) => q.id)).toEqual(['q-worry'])
    expect(loadThinkView(db, T0 + 7 * DAY).toThink.map((q) => q.id)).toEqual(['q-worry', 'q-loop'])
    expect(inboxCount(db)).toBe(0)
  })

  test('Answered · N: answered questions with their answer count, and Add more stays open', () => {
    const { db, deps } = seeded()
    deps.clock.now = T0 + 60_000
    captureBullet(
      db,
      { text: 'mostly that everyone else has done it before', answersQuestionId: 'q-worry' },
      deps,
    )
    deps.clock.now = T0 + 120_000
    captureBullet(db, { text: 'and that my hands shake a bit', answersQuestionId: 'q-worry' }, deps)
    const view = loadThinkView(db, T0 + 180_000)
    expect(view.toThink.map((q) => q.id)).toEqual(['q-loop', 'q-evergreen'])
    expect(view.answered).toMatchObject([{ id: 'q-worry', answers: 2 }])
    // "Add more" opens the answer screen with the question pinned, reflective wording.
    expect(findPinned(db, { question: 'q-worry' })).toMatchObject({
      kind: 'question',
      reflective: true,
      origin: 'capture',
    })
  })
})

describe('source lines', () => {
  const src = { source: 'text' as const, capturedAt: T0, timezone: TZ }
  test('capture, open loop, evergreen', () => {
    expect(questionSourceLine('capture', src, T0 + DAY)).toBe('From your note, yesterday 09:12')
    expect(questionSourceLine('open_loop', src, T0 + 9 * DAY)).toBe('From an open loop, 9 days ago')
    expect(questionSourceLine('evergreen', src, T0)).toBeNull()
    expect(questionSourceLine('capture', null, T0)).toBeNull()
    expect(daysAgo(T0, T0 + DAY - 1)).toBe('today')
    expect(daysAgo(T0, T0 + DAY)).toBe('yesterday')
  })
})

describe('Pick a question', () => {
  test('every evergreen question but the ones let go or already waiting', () => {
    const { db, deps } = seeded()
    const ids = () => evergreenChoices(db).choices.map((q) => q.id)
    // "surprised" is waiting in To think about.
    expect(ids()).not.toContain('surprised')
    expect(ids()).toHaveLength(EVERGREEN_QUESTIONS.length - 1)
    // "Not this one": gone from the list for good.
    dismissQuestion(db, 'q-evergreen', deps)
    expect(ids()).not.toContain('surprised')
    // A second Later is not "Not this one": the question may be picked again.
    const picked = pickEvergreen(db, 'small-good', deps)
    expect(ids()).not.toContain('small-good')
    snoozeQuestion(db, picked, deps)
    snoozeQuestion(db, picked, deps)
    expect(ids()).toContain('small-good')
  })

  test('a pick is answerable at once; enough open ones stop more picks', () => {
    const { db, deps } = seeded()
    expect(evergreenChoices(db).canPick).toBe(true)
    const id = pickEvergreen(db, 'enough', deps)
    expect(findPinned(db, { question: id })).toMatchObject({
      reflective: true,
      origin: 'evergreen',
      source: null,
      text: 'What would make this week feel like enough?',
    })
    // Three were open; a pick may make it four, and no more.
    expect(evergreenChoices(db).canPick).toBe(false)
  })

  test('a pick the server refuses is explained calmly in the Inbox', () => {
    const { db, deps } = seeded()
    const id = pickEvergreen(db, 'enough', deps)
    db.transaction((tx) =>
      recordRejection(
        tx,
        { op_id: 'op-1', type: 'question.pick_evergreen', suggestion_id: null, question_id: id },
        'invalid',
        'too many open',
        T0 + 5,
      ),
    )
    const [r] = listRejections(db)
    expect(r?.type).toBe('question.pick_evergreen')
    const rows = loadInboxRows(db, { now: T0 + 10, timezone: TZ, heldIds: [] })
    expect(rows.rejections).toHaveLength(1)
    expect(noticeText(r!, new Map(), summaryContext(db, [], T0, TZ))).toBe(PICK_REFUSED_TEXT)
    expect(PICK_REFUSED_TEXT).toBe("That question couldn't be added. Your answer is still saved.")
    // The phone's copy of the question is gone.
    expect(findPinned(db, { question: id })).toBeNull()
  })
})

describe('answers and the capture they are about', () => {
  test('the Stream card says what it is thinking about and links to its source', () => {
    const { db, deps, worry } = seeded()
    deps.clock.now = T0 + 60_000
    const answer = captureBullet(
      db,
      { text: 'mostly that everyone else has done it before', answersQuestionId: 'q-worry' },
      deps,
    )
    deps.clock.now = T0 + 120_000
    const evergreenAnswer = captureBullet(
      db,
      { text: 'how warm October has been', answersQuestionId: 'q-evergreen' },
      deps,
    )
    const cards = new Map(listCaptureCards(db, 10, T0 + 180_000).cards.map((c) => [c.id, c]))
    expect(cards.get(answer)?.thinkingAbout).toEqual({
      text: 'You said «nervous about the pottery class». What part of it feels big?',
      sourceBulletId: worry,
    })
    // An evergreen question has no capture to open.
    expect(cards.get(evergreenAnswer)?.thinkingAbout).toEqual({
      text: 'What surprised you this week?',
      sourceBulletId: null,
    })
    expect(cards.get(worry)?.thinkingAbout).toBeNull()
    expect(thinkingAboutLabel('What surprised you this week?')).toBe(
      'Thinking about: «What surprised you this week?»',
    )
  })

  test('Capture detail links both ways', () => {
    const { db, deps, worry } = seeded()
    deps.clock.now = T0 + 60_000
    const a1 = captureBullet(
      db,
      { text: 'mostly that everyone else has done it before', answersQuestionId: 'q-worry' },
      deps,
    )
    deps.clock.now = T0 + 120_000
    const a2 = captureBullet(
      db,
      { text: 'and that my hands shake a bit', answersQuestionId: 'q-worry' },
      deps,
    )
    const answer = loadCaptureDetail(db, a1, T0 + 180_000, TZ)
    expect(answer?.thinkingAbout).toEqual({
      questionId: 'q-worry',
      text: 'You said «nervous about the pottery class». What part of it feels big?',
      sourceBulletId: worry,
      sourceLine: 'From your voice note, today 09:12',
      canAddMore: true,
    })
    expect(answer?.thoughtAbout).toEqual([])

    const source = loadCaptureDetail(db, worry, T0 + 180_000, TZ)
    expect(source?.thinkingAbout).toBeNull()
    expect(source?.thoughtAbout.map((a) => a.id)).toEqual([a1, a2])
    expect(answersAbout(db, worry)[1]).toMatchObject({
      snippet: '“and that my hands shake a bit”',
      source: 'text',
      capturedAt: T0 + 120_000,
    })
  })

  test('a clarifying answer gets no header', () => {
    const { db, deps, worry } = seeded()
    db.insert(questions)
      .values({
        ...reflective({ id: 'q-clarify', source_bullet_id: worry }),
        kind: 'clarifying',
        text: 'Which Saturday?',
        options: ['This one', 'Next one'],
      })
      .run()
    const a = captureBullet(db, { text: 'the next one', answersQuestionId: 'q-clarify' }, deps)
    expect(listCaptureCards(db, 10, T0).cards.find((c) => c.id === a)?.thinkingAbout).toBeNull()
    expect(loadCaptureDetail(db, worry, T0, TZ)?.thoughtAbout).toEqual([])
  })
})
