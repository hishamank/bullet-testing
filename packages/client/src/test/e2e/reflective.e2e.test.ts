/**
 * Slice 2 (reflective questions), end to end, against a REAL home server. Skipped unless
 * BULLET_E2E_URL is set; same setup as capture-loop.e2e.test.ts. Use a FRESH throwaway database:
 * the limits (3 open, 2 a day) are per user, so earlier runs' questions would hold this one back.
 *
 * Asserted: the contract (a question only after the capture's things, at most one per capture,
 * never in To clarify, answering offline works). Recorded as quality notes: whether the model
 * asked at all, quoted the user, stayed in their language and gave no advice.
 */

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test'
import { captureBullet, pickEvergreen } from '../../data/local'
import {
  listAnsweredReflective,
  listOpenQuestions,
  listQuestionsToThinkAbout,
} from '../../data/queries'
import { bullets, questions, suggestions, thoughts } from '../../data/schema'
import { TransportError, type SyncTransport } from '../../sync/transport'
import { createPhone, E2E, enabled, isSettled, quality, record, syncUntil } from './harness'

const MIN = 60_000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!enabled)('slice 2 end to end: reflective questions', () => {
  let offline = false
  const p = createPhone({
    wrap: (t): SyncTransport => ({
      push: (req) =>
        offline ? Promise.reject(new TransportError('network', 'offline')) : t.push(req),
      pull: (q) => (offline ? Promise.reject(new TransportError('network', 'offline')) : t.pull(q)),
      audioStatus: (id) => t.audioStatus(id),
      uploadAudio: (id, offset, bytes) => t.uploadAudio(id, offset, bytes),
    }),
  })

  beforeAll(async () => {
    record({ type: 'run', suite: 'reflective', url: E2E.url })
    await p.sync()
  })
  afterAll(() => p.client.dispose())

  test(
    'a worry capture: things first, then at most one reflective question; answered offline',
    async () => {
      const text =
        "I'm dreading Monday's meeting with Karim, I never know what he really thinks. " +
        'Need to call the bank tomorrow.'
      const id = captureBullet(p.db, { text }, p.deps)
      const t0 = Date.now()
      await syncUntil(p, id, isSettled, 5 * MIN)
      const settledMs = Date.now() - t0
      const things = p.db
        .select()
        .from(suggestions)
        .where(eq(suggestions.source_bullet_id, id))
        .all()
      record({ type: 'reflective_capture', settledMs, things: things.length })

      // The reflect job runs after extraction; give it a little while.
      let q: typeof questions.$inferSelect | undefined
      for (let i = 0; i < 60 && !q; i++) {
        await p.sync()
        q = p.db
          .select()
          .from(questions)
          .all()
          .find((x) => x.kind === 'reflective' && x.source_bullet_id === id)
        if (!q) await sleep(1_000)
      }
      const reflectMs = Date.now() - t0
      quality('reflective: the model asked a question', Boolean(q), q?.text)
      if (q) {
        record({ type: 'reflective_question', text: q.text, ms: reflectMs })
        expect(q.created_at).toBeGreaterThanOrEqual(Math.max(...things.map((s) => s.created_at), 0))
        expect(listOpenQuestions(p.db).some((x) => x.id === q?.id)).toBe(false)
        const worry = p.db
          .select()
          .from(thoughts)
          .all()
          .find((t) => t.id === q?.source_thought_id)
        quality('reflective: about the worry', worry?.kind === 'worry', worry)
        quality('reflective: quotes the user («…»)', /«[^»]+»/.test(q.text), q.text)
        quality(
          'reflective: no advice',
          !/\b(you should|try to|have you tried|make sure)\b/i.test(q.text),
          q.text,
        )
        const all = p.db.select().from(questions).all()
        expect(
          all.filter((x) => x.kind === 'reflective' && x.source_bullet_id === id),
        ).toHaveLength(1)
      }
      const target = q?.id ?? pickEvergreen(p.db, 'enough', p.deps)
      expect(listQuestionsToThinkAbout(p.db, Date.now()).map((v) => v.question.id)).toContain(
        target,
      )

      // Journal about it, offline: saved on the phone, answered there at once.
      offline = true
      const answer = captureBullet(
        p.db,
        {
          text: 'Honestly it is the silence after I talk. Remind me to book a 1:1 with Karim on Friday.',
          answersQuestionId: target,
        },
        p.deps,
      )
      expect(p.db.select().from(questions).where(eq(questions.id, target)).get()?.status).toBe(
        'answered',
      )
      offline = false
      await syncUntil(p, answer, isSettled, 5 * MIN)
      const b = p.db.select().from(bullets).where(eq(bullets.id, answer)).get()
      const ts = p.db.select().from(thoughts).where(eq(thoughts.source_bullet_id, answer)).all()
      const ss = p.db
        .select()
        .from(suggestions)
        .where(eq(suggestions.source_bullet_id, answer))
        .all()
      record({
        type: 'reflective_answer',
        status: b?.server_status,
        thoughts: ts.map((t) => [t.kind, t.text]),
        things: ss.map((s) => [s.target_kind, s.payload]),
      })
      expect(b?.answers_question_id).toBe(target)
      expect(ts.length).toBeGreaterThan(0)
      quality('reflective answer: a task was extracted from it', ss.length > 0, ss.length)
      expect(p.db.select().from(questions).where(eq(questions.id, target)).get()?.status).toBe(
        'answered',
      )
      expect(listAnsweredReflective(p.db).items.some((v) => v.question.id === target)).toBe(true)
    },
    12 * MIN,
  )
})
