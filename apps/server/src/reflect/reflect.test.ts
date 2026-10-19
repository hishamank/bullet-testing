import { pullResponseSchema, REFLECTIVE_CAPS } from '@bullet/core'
import { createScriptedLlmClient, type LlmChatRequest, REFLECT_SYSTEM_PROMPT } from '@bullet/engine'
import { and, eq } from 'drizzle-orm'
import { describe, expect, test } from 'vite-plus/test'
import { bullets, questions, reflectJobs, suggestions, thoughts } from '../db/schema'
import { candidate, createHarness, type SegmentScript, T0, uid } from '../test/helpers'
import { runReflectionPass } from './pass'

const DAY = 24 * 60 * 60 * 1000

/**
 * Captures are written as `kind: words` parts joined by " | " ("worry: dreading Monday | task:
 * call the bank"); a part after "sensitive " is flagged by the model.
 */
const segment: SegmentScript = (capture) =>
  capture.split(' | ').map((part) => {
    const m = /^(sensitive )?(\w+): (.*)$/.exec(part.trim())
    const text = m?.[3] ?? part.trim()
    return {
      text,
      quote: text,
      kind: (m?.[2] ?? 'note') as never,
      ...(m?.[1] ? { sensitive: true } : {}),
    }
  })

const isReflect = (req: LlmChatRequest) => req.messages[0]?.content === REFLECT_SYSTEM_PROMPT

/**
 * The model: extraction finds a task in "task:" parts; reflection asks about thought 1, quoting
 * its first three words (or declines, or answers garbage, as `reflect` says).
 */
function model(reflect: 'ask' | 'decline' | 'garbage' | 'down' = 'ask') {
  return createScriptedLlmClient({
    chat: (req) => {
      if (isReflect(req)) {
        if (reflect === 'down') throw new Error('llama-server is down')
        if (reflect === 'garbage') return 'I would ask about the meeting.'
        if (reflect === 'decline') {
          return JSON.stringify({ ask: false, thought: 0, quote: '', question: '' })
        }
        const first = /^1\. \[\w+\] (.*)$/m.exec(req.messages[1]?.content ?? '')?.[1] ?? ''
        const quote = first.split(' ').slice(0, 3).join(' ')
        return JSON.stringify({
          ask: true,
          thought: 1,
          quote,
          question: `You wrote «${quote}». What about it stays with you?`,
        })
      }
      const text = /"""\n([\s\S]*?)\n"""/.exec(req.messages[1]?.content ?? '')?.[1] ?? ''
      return JSON.stringify({
        candidates: /call|pay|book/i.test(text)
          ? [
              candidate({
                kind: 'task',
                orientation: 'future_oneoff',
                text,
                fields: { title: text },
              }),
            ]
          : [],
      })
    },
  })
}

function setup(reflect: Parameters<typeof model>[0] = 'ask') {
  const llm = model(reflect)
  const h = createHarness(llm, {}, segment)
  const reflective = () =>
    h.db
      .select()
      .from(questions)
      .where(eq(questions.kind, 'reflective'))
      .all()
      .sort((a, b) => a.created_at - b.created_at)
  const live = () =>
    reflective().filter(
      (q) => q.state === 'active' && (q.status === 'open' || q.status === 'snoozed'),
    )
  const thoughtOf = (bulletId: string, kind: string) =>
    h.db
      .select()
      .from(thoughts)
      .where(and(eq(thoughts.source_bullet_id, bulletId), eq(thoughts.kind, kind as never)))
      .get()
  /** Capture at the harness clock (not T0). */
  const capture = async (text: string, extra = {}) => {
    const id = await h.capture(text, { captured_at: h.clock.now, ...extra })
    await h.worker.drain()
    return id
  }
  const pass = () => runReflectionPass(h.db, h.clock.now)
  const op = async (o: Record<string, unknown>) =>
    (await h.push([{ op_id: uid(), ...o } as never])).results[0]
  return { h, llm, reflective, live, thoughtOf, capture, pass, op }
}

describe('a reflective question from a capture', () => {
  test('a worry yields one question, quoting it, made only after its things are done', async () => {
    const { h, llm, reflective, thoughtOf } = setup()
    const b1 = await h.capture("worry: dreading Monday's meeting with Karim | task: call the bank")
    const b2 = await h.capture('idea: a small café in Beirut | task: pay the rent')
    await h.worker.drain()

    // Both captures' extraction ran before any reflection: a question never delays things.
    const kinds = llm.chatCalls.map((c) => (isReflect(c) ? 'reflect' : 'extract'))
    expect(kinds).toEqual(['extract', 'extract', 'reflect', 'reflect'])
    expect(h.db.select().from(suggestions).all()).toHaveLength(2)
    expect(
      h.db
        .select()
        .from(bullets)
        .all()
        .map((b) => b.proc_status),
    ).toEqual(['needs_review', 'needs_review'])

    const qs = reflective()
    expect(qs).toHaveLength(2)
    expect(qs[0]).toMatchObject({
      kind: 'reflective',
      origin: 'capture',
      topic: 'other',
      options: [],
      status: 'open',
      source_bullet_id: b1,
      source_thought_id: thoughtOf(b1, 'worry')?.id,
      text: "You wrote «dreading Monday's meeting». What about it stays with you?",
    })
    expect(qs[1]?.source_bullet_id).toBe(b2)
    // The prompt saw only the worry, never the task.
    const prompt = llm.chatCalls.find(isReflect)?.messages[1]?.content ?? ''
    expect(prompt).toContain("1. [worry] dreading Monday's meeting with Karim")
    expect(prompt).not.toContain('call the bank')

    // At most one per capture: processing again asks nothing new.
    await h.push([
      {
        op_id: uid(),
        type: 'bullet.edit',
        bullet_id: b1,
        text: "worry: dreading Monday's meeting with Karim | task: call the bank today",
        edited_at: T0 + 1,
      },
    ])
    await h.worker.drain()
    expect(reflective()).toHaveLength(2)
  })

  test('only worries, self-questions and ideas: a task alone asks nothing, no model call', async () => {
    const { llm, reflective, capture } = setup()
    await capture('task: call the bank | note: sunny day')
    expect(reflective()).toHaveLength(0)
    expect(llm.chatCalls.filter(isReflect)).toHaveLength(0)
  })

  test('bad model output, a decline, or the model down: no question, capture unaffected', async () => {
    for (const mode of ['garbage', 'decline', 'down'] as const) {
      const { h, reflective, capture } = setup(mode)
      const b = await capture('worry: the rent is late')
      h.clock.now += 60 * 60 * 1000
      await h.worker.drain()
      expect(reflective(), mode).toHaveLength(0)
      expect(h.db.select().from(bullets).where(eq(bullets.id, b)).get()?.proc_status, mode).toBe(
        'processed',
      )
    }
  })

  test('the model down: retried a few times, then dropped quietly', async () => {
    const { h, llm, capture } = setup('down')
    await capture('worry: the rent is late')
    for (let i = 0; i < 6; i++) {
      h.clock.now += DAY
      await h.worker.drain()
    }
    expect(llm.chatCalls.filter(isReflect)).toHaveLength(3)
    expect(h.db.select().from(reflectJobs).get()?.status).toBe('failed')
  })

  test('a capture answering a reflective question gets none of its own', async () => {
    const { reflective, capture } = setup()
    await capture('worry: the rent is late')
    const [q] = reflective()
    await capture('worry: still anxious about money honestly', { answers_question_id: q?.id })
    expect(reflective()).toHaveLength(1)
    expect(reflective()[0]?.status).toBe('answered')
  })
})

describe('limits across all sources', () => {
  test('at most 2 new a day and 3 open, across captures, loops and evergreen', async () => {
    const { h, live, reflective, capture, pass, op } = setup()
    await capture('worry: one')
    await capture('worry: two')
    await capture('worry: three')
    // Day 1: two, the third capture is over the daily limit (and the pass adds nothing).
    expect(live()).toHaveLength(2)
    pass()
    expect(live()).toHaveLength(2)

    h.clock.now += DAY + 1
    await capture('worry: four')
    expect(live()).toHaveLength(3)
    // Three open: generation pauses, whatever the source.
    await capture('to_check: check the passport')
    h.clock.now += 8 * DAY
    await capture('worry: five')
    pass()
    expect(live()).toHaveLength(3)

    // One answered: room again, and the stale loop gets its turn.
    await op({ type: 'question.dismiss', question_id: live()[0]?.id })
    pass()
    expect(live()).toHaveLength(3)
    expect(reflective().at(-1)?.origin).toBe('open_loop')
    expect(REFLECTIVE_CAPS.maxOpen).toBe(3)
  })

  test('nothing new after 14 days without a capture', async () => {
    const { h, reflective, capture, pass } = setup()
    await capture('to_check: check the passport')
    h.clock.now += 14 * DAY
    pass()
    expect(reflective()).toHaveLength(0)
  })
})

describe('stale open loops', () => {
  test('a to_check untouched for 7 days yields exactly one question; a resolved one never', async () => {
    const { h, reflective, capture, pass, thoughtOf, op } = setup()
    const b = await capture('to_check: check if the passport expires')
    const resolved = await capture('to_check: check the car insurance')
    await op({ type: 'thought.resolve', thought_id: thoughtOf(resolved, 'to_check')?.id })

    const loops = () => reflective().filter((q) => q.origin === 'open_loop')
    h.clock.now = T0 + 6 * DAY
    pass()
    expect(loops()).toHaveLength(0)
    h.clock.now = T0 + 7 * DAY
    pass()
    expect(loops()).toHaveLength(1)
    expect(loops()[0]).toMatchObject({
      origin: 'open_loop',
      text: 'Still on your mind? «check if the passport expires»',
      source_bullet_id: b,
      source_thought_id: thoughtOf(b, 'to_check')?.id,
    })
    // One per loop, ever: dismissed or not, never again.
    await op({ type: 'question.snooze', question_id: loops()[0]?.id })
    await op({ type: 'question.snooze', question_id: loops()[0]?.id })
    for (const d of [8, 10, 12]) {
      h.clock.now = T0 + d * DAY
      pass()
    }
    expect(loops()).toHaveLength(1)
    expect(loops()[0]?.source_bullet_id).not.toBe(resolved)
  })
})

describe('evergreen questions', () => {
  test('only when none is open, at most once every 3 days', async () => {
    const { h, reflective, live, capture, pass, op } = setup()
    await capture('note: quiet day at home')
    pass()
    expect(live()).toHaveLength(1)
    const first = live()[0]
    expect(first).toMatchObject({ origin: 'evergreen', source_bullet_id: null })
    expect(first?.template_id).toBeTruthy()

    h.clock.now += DAY
    pass()
    expect(reflective()).toHaveLength(1)
    // Not this one: dismissed; still 3 days apart, and that template never comes back.
    await op({ type: 'question.dismiss', question_id: first?.id })
    h.clock.now = T0 + 2 * DAY
    pass()
    expect(reflective()).toHaveLength(1)
    h.clock.now = T0 + 3 * DAY
    pass()
    expect(reflective()).toHaveLength(2)
    expect(reflective()[1]?.template_id).not.toBe(first?.template_id)

    // Another source open: no evergreen question beside it.
    await op({ type: 'question.dismiss', question_id: reflective()[1]?.id })
    await capture('worry: the rent is late')
    h.clock.now = T0 + 7 * DAY
    pass()
    expect(live().map((q) => q.origin)).toEqual(['capture'])
  })

  test('picked by the user: may go one over the open cap, never more', async () => {
    const { h, live, capture, op } = setup()
    h.clock.now = T0
    await capture('worry: one')
    await capture('worry: two')
    h.clock.now += DAY + 1
    await capture('worry: three')
    expect(live()).toHaveLength(3)
    const id = uid()
    expect(
      await op({ type: 'question.pick_evergreen', question_id: id, template_id: 'enough' }),
    ).toMatchObject({ status: 'applied' })
    expect(live()).toHaveLength(4)
    expect(live().find((q) => q.id === id)).toMatchObject({
      origin: 'evergreen',
      template_id: 'enough',
      text: 'What would make this week feel like enough?',
    })
    expect(
      await op({ type: 'question.pick_evergreen', question_id: id, template_id: 'enough' }),
    ).toMatchObject({ status: 'duplicate' })
    const over = await op({
      type: 'question.pick_evergreen',
      question_id: uid(),
      template_id: 'surprised',
    })
    expect(over).toMatchObject({ status: 'rejected', error: { code: 'conflict' } })
    const unknown = await op({
      type: 'question.pick_evergreen',
      question_id: uid(),
      template_id: 'nope',
    })
    expect(unknown).toMatchObject({ status: 'rejected', error: { code: 'invalid' } })
  })
})

describe('the user acting on reflective questions', () => {
  test('"Not this one" is permanent, even after reprocessing the capture', async () => {
    const { h, llm, reflective, thoughtOf, capture, pass, op } = setup()
    const b = await capture('question: should I move to Lisbon | task: call the movers')
    const [q] = reflective()
    expect(q?.source_thought_id).toBe(thoughtOf(b, 'question')?.id)
    await op({ type: 'question.dismiss', question_id: q?.id })
    expect(thoughtOf(b, 'question')?.never_ask).toBe(true)
    const calls = llm.chatCalls.filter(isReflect).length

    // Re-processed (an edit that keeps the thought): its id and never_ask survive; nothing asked.
    await h.push([
      {
        op_id: uid(),
        type: 'bullet.edit',
        bullet_id: b,
        text: 'question: should I move to Lisbon | task: call the movers on Monday',
        edited_at: T0 + 1,
      },
    ])
    await h.worker.drain()
    expect(thoughtOf(b, 'question')).toMatchObject({ id: q?.source_thought_id, never_ask: true })
    expect(llm.chatCalls.filter(isReflect)).toHaveLength(calls)
    // A week later, the open loop is not asked about either.
    h.clock.now = T0 + 8 * DAY
    await capture('note: still here')
    pass()
    expect(reflective().filter((x) => x.origin !== 'evergreen')).toHaveLength(1)
    expect(reflective()[0]?.status).toBe('dismissed')
  })

  test('Later hides it for 7 days; a second Later dismisses it quietly', async () => {
    const { h, reflective, thoughtOf, capture, pass, op } = setup()
    const b = await capture('worry: the rent is late')
    const id = reflective()[0]?.id
    expect(await op({ type: 'question.snooze', question_id: id })).toMatchObject({
      status: 'applied',
    })
    expect(reflective()[0]).toMatchObject({
      status: 'snoozed',
      snooze_count: 1,
      snoozed_until: T0 + 7 * DAY,
    })
    h.clock.now = T0 + 7 * DAY - 1
    pass()
    expect(reflective()[0]?.status).toBe('snoozed')
    h.clock.now = T0 + 7 * DAY
    pass()
    expect(reflective()[0]?.status).toBe('open')
    await op({ type: 'question.snooze', question_id: id })
    expect(reflective()[0]).toMatchObject({ status: 'dismissed', snooze_count: 2 })
    // Quietly: the thought is not marked never-ask.
    expect(thoughtOf(b, 'worry')?.never_ask).toBe(false)
  })

  test('tapping an option is refused for a reflective question; Later for a clarifying one', async () => {
    const { h, reflective, capture, op } = setup()
    await capture('worry: the rent is late')
    const answer = await op({
      type: 'question.answer',
      question_id: reflective()[0]?.id,
      option: 'Yes',
    })
    expect(answer).toMatchObject({ status: 'rejected', error: { code: 'invalid' } })
    const clarifying = uid()
    h.db
      .insert(questions)
      .values({
        id: clarifying,
        owner_id: h.ownerId,
        source_bullet_id: reflective()[0]?.source_bullet_id ?? null,
        source_thought_id: null,
        suggestion_id: null,
        topic: 'other',
        text: 'Which bank?',
        options: [],
        status: 'open',
        answer_bullet_id: null,
        resolved_at: null,
        created_at: T0,
        updated_at: T0,
      })
      .run()
    expect(await op({ type: 'question.snooze', question_id: clarifying })).toMatchObject({
      status: 'rejected',
      error: { code: 'invalid' },
    })
  })

  test('Journal about it: answered by a capture, more answers allowed, all pulled', async () => {
    const { h, reflective, capture } = setup()
    await capture('worry: the rent is late')
    const q = reflective()[0]
    const a1 = await capture('note: it is mostly the uncertainty', { answers_question_id: q?.id })
    const a2 = await capture('note: and the landlord never replies', { answers_question_id: q?.id })
    expect(reflective()[0]).toMatchObject({ status: 'answered', answer_bullet_id: a1 })
    const pulled = pullResponseSchema.parse(await h.pull())
    expect(pulled.changes.questions.find((x) => x.id === q?.id)).toMatchObject({
      kind: 'reflective',
      origin: 'capture',
      status: 'answered',
      snooze_count: 0,
      template_id: null,
    })
    expect(
      pulled.changes.bullets.filter((b) => b.answers_question_id === q?.id).map((b) => b.id),
    ).toEqual([a1, a2])
    expect(pulled.changes.thoughts.every((t) => t.sensitive === false)).toBe(true)
  })
})

describe('sensitive thoughts', () => {
  test('no question of any source, and evergreen questions pause for 7 days', async () => {
    const { h, llm, reflective, thoughtOf, capture, pass } = setup()
    const b = await capture(
      'worry: everything is too much | sensitive note: I keep thinking about not waking up | to_check: check the appointment',
    )
    expect(thoughtOf(b, 'note')?.sensitive).toBe(true)
    // The capture is kept, split and extracted as usual; nothing is asked about it.
    expect(h.db.select().from(thoughts).all()).toHaveLength(3)
    expect(llm.chatCalls.filter(isReflect)).toHaveLength(0)
    expect(h.db.select().from(reflectJobs).all()).toHaveLength(0)
    // Its open loop never gets "Still on your mind?", and evergreen questions wait a week.
    for (const d of [1, 3, 6]) {
      h.clock.now = T0 + d * DAY
      pass()
    }
    expect(reflective()).toHaveLength(0)
    h.clock.now = T0 + 7 * DAY + 1
    pass()
    expect(reflective().map((q) => q.origin)).toEqual(['evergreen'])
    // The flag is pulled (never shown).
    const pulled = pullResponseSchema.parse(await h.pull())
    expect(pulled.changes.thoughts.filter((t) => t.sensitive)).toHaveLength(1)
  })

  test('a capture edited into distress withdraws its open question', async () => {
    const { h, live, capture } = setup()
    const b = await capture('worry: the rent is late')
    expect(live()).toHaveLength(1)
    await h.push([
      {
        op_id: uid(),
        type: 'bullet.edit',
        bullet_id: b,
        text: 'worry: the rent is late | note: I want to die',
        edited_at: T0 + 1,
      },
    ])
    await h.worker.drain()
    expect(live()).toHaveLength(0)
  })
})
