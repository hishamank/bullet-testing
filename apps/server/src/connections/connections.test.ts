import { CONNECTION_OPTIONS, pullResponseSchema, REFLECTIVE_CAPS } from '@bullet/core'
import {
  ANSWER_CHECK_SYSTEM_PROMPT,
  createScriptedEmbedder,
  createScriptedLlmClient,
  DEDICATED_PROFILE,
  LINK_REVIEW_SYSTEM_PROMPT,
  type LlmChatRequest,
  REFLECT_SYSTEM_PROMPT,
  THEME_NAME_SYSTEM_PROMPT,
} from '@bullet/engine'
import { and, eq } from 'drizzle-orm'
import { describe, expect, test } from 'vite-plus/test'
import {
  bullets,
  linkJobs,
  noticedCards,
  questions,
  suggestions,
  themes,
  themeThoughts,
  thoughtLinks,
  thoughts,
} from '../db/schema'
import { createHarness, type SegmentScript, uid } from '../test/helpers'
import { nightlyDue, nightlySlot, runNightly } from './nightly'
import { isVetoed } from './store'

const DAY = 24 * 60 * 60 * 1000
const MIN = 60 * 1000

/**
 * Captures are `kind: words` parts joined by " | "; "sensitive " before a part flags it, and
 * "@Name" marks a named entity (written without the @ in the thought).
 */
const segment: SegmentScript = (capture) =>
  capture.split(' | ').map((part) => {
    const m = /^(sensitive )?(\w+): (.*)$/.exec(part.trim())
    const raw = m?.[3] ?? part.trim()
    const text = raw.replace(/@/g, '')
    return {
      text,
      quote: text,
      kind: (m?.[2] ?? 'note') as never,
      entities: [...raw.matchAll(/@(\w+)/g)].map((x) => x[1] as string),
      ...(m?.[1] ? { sensitive: true } : {}),
    }
  })

/**
 * Vectors by thought text: `[topic, c]` gives `c` on the topic's axis and the rest on the text's
 * own axis, so two texts of one topic score c1 × c2 (a `c = 1` anchor scores exactly the other's
 * c). Unknown texts are orthogonal to everything.
 */
function topicEmbedder(table: Record<string, [string, number]>) {
  const axes = new Map<string, number>()
  const axis = (k: string) => {
    if (!axes.has(k)) axes.set(k, axes.size)
    return axes.get(k) as number
  }
  return createScriptedEmbedder((text) => {
    const v = Array.from({ length: 512 }, () => 0)
    const entry = table[text]
    const own = axis(`own:${text}`)
    if (!entry) {
      v[own] = 1
      return v
    }
    const [topic, c] = entry
    v[axis(`topic:${topic}`)] = c
    v[own] = Math.sqrt(Math.max(0, 1 - c * c))
    return v
  }, 'test-embed')
}

const sys = (req: LlmChatRequest) => req.messages[0]?.content
const userOf = (req: LlmChatRequest) => req.messages[1]?.content ?? ''

interface ModelOptions {
  answers?: (loop: string, later: string) => 'yes' | 'no' | 'unsure'
  reflect?: 'ask' | 'decline'
  review?: (a: string, b: string) => 'same_entity' | 'same_topic' | 'unrelated'
  name?: (notes: string) => string
}

function model(o: ModelOptions = {}) {
  return createScriptedLlmClient({
    chat: (req) => {
      const s = sys(req)
      if (s === ANSWER_CHECK_SYSTEM_PROMPT) {
        const [, loop = '', later = ''] = /^FIRST: (.*)\nSECOND: (.*)$/s.exec(userOf(req)) ?? []
        return JSON.stringify({ answers: o.answers?.(loop, later) ?? 'no' })
      }
      if (s === REFLECT_SYSTEM_PROMPT) {
        if (o.reflect !== 'ask')
          return JSON.stringify({ ask: false, thought: 0, quote: '', question: '' })
        const first = /^1\. \[\w+\] (.*)$/m.exec(userOf(req))?.[1] ?? ''
        const quote = first.split(' ').slice(0, 3).join(' ')
        return JSON.stringify({
          ask: true,
          thought: 1,
          quote,
          question: `You wrote «${quote}». What about it stays with you?`,
        })
      }
      if (s === LINK_REVIEW_SYSTEM_PROMPT) {
        const [, a = '', b = ''] = /^NOTE 1: (.*)\nNOTE 2: (.*)$/s.exec(userOf(req)) ?? []
        return JSON.stringify({ relation: o.review?.(a, b) ?? 'same_topic' })
      }
      if (s === THEME_NAME_SYSTEM_PROMPT) {
        return JSON.stringify({ name: o.name?.(userOf(req)) ?? 'the rent' })
      }
      return JSON.stringify({ candidates: [] })
    },
  })
}

function setup(table: Record<string, [string, number]>, o: ModelOptions = {}) {
  const llm = model(o)
  const embedder = topicEmbedder(table)
  const h = createHarness(llm, { embedder, embedProfile: DEDICATED_PROFILE }, segment)
  /** Capture at the harness clock and process everything that is ready. */
  const capture = async (text: string, extra = {}) => {
    const id = await h.capture(text, { captured_at: h.clock.now, ...extra })
    await h.worker.drain()
    return id
  }
  const thoughtOf = (bulletId: string, position = 0) =>
    h.db
      .select()
      .from(thoughts)
      .where(
        and(
          eq(thoughts.source_bullet_id, bulletId),
          eq(thoughts.position, position),
          eq(thoughts.state, 'active'),
        ),
      )
      .get()
  const links = () => h.db.select().from(thoughtLinks).where(eq(thoughtLinks.state, 'active')).all()
  const resolves = () =>
    h.db
      .select()
      .from(suggestions)
      .where(and(eq(suggestions.target_kind, 'thought_resolve'), eq(suggestions.state, 'active')))
      .all()
  const reflective = () =>
    h.db
      .select()
      .from(questions)
      .where(and(eq(questions.kind, 'reflective'), eq(questions.state, 'active')))
      .all()
  const op = async (o2: Record<string, unknown>) =>
    (await h.push([{ op_id: uid(), ...o2 } as never])).results[0]
  const edit = (bulletId: string, text: string) =>
    op({ type: 'bullet.edit', bullet_id: bulletId, text, edited_at: h.clock.now })
  const nightly = () =>
    runNightly(
      {
        db: h.db,
        llm,
        engine: { ...h.engine, model: 'nightly' },
        embedder,
        profile: DEDICATED_PROFILE,
        now: () => h.clock.now,
      },
      nightlySlot(h.clock.now, 'UTC'),
    )
  return { h, llm, embedder, capture, thoughtOf, links, resolves, reflective, op, edit, nightly }
}

// --- links ---

describe('links between captures', () => {
  const table: Record<string, [string, number]> = {
    'the rent is going up again': ['rent', 1],
    'the landlord wants more rent': ['rent', 0.82],
    'rent money is tight': ['rent', 0.78],
    'dinner with Karim': ['karim', 1],
    'Karim called about the trip': ['karim', 0.76],
    'Karim seemed tired': ['karim', 0.72],
  }

  test('linked at 0.80 or more; below threshold dropped, never queued', async () => {
    const { capture, links, thoughtOf, h } = setup(table)
    const a = await capture('note: the rent is going up again')
    h.clock.now += DAY
    const b = await capture('note: the landlord wants more rent')
    const c = await capture('note: rent money is tight')
    const all = links()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({
      a_thought_id: thoughtOf(a)?.id,
      b_thought_id: thoughtOf(b)?.id,
      a_bullet_id: a,
      b_bullet_id: b,
      type: 'same_topic',
      origin: 'capture',
    })
    expect(all[0]?.score).toBeCloseTo(0.82, 2)
    // 0.78 is below 0.80 and they share no name: nothing, and nothing waiting either.
    expect(all.some((l) => l.b_bullet_id === c)).toBe(false)
    expect(h.db.select().from(linkJobs).where(eq(linkJobs.bullet_id, c)).get()?.status).toBe('done')
  })

  test('a shared name links from 0.75 (same_entity), not below', async () => {
    const { capture, links, h } = setup(table)
    await capture('event: dinner with @Karim')
    h.clock.now += DAY
    const b = await capture('note: @Karim called about the trip')
    const c = await capture('note: @Karim seemed tired')
    expect(links().map((l) => [l.b_bullet_id, l.type])).toEqual([[b, 'same_entity']])
    expect(links().some((l) => l.b_bullet_id === c)).toBe(false)
  })

  test('at most 5 links per thought, the closest kept', async () => {
    const t: Record<string, [string, number]> = { 'sleep again': ['sleep', 1] }
    // 0.88 … 0.81 to the new one, under 0.80 to each other: only the new thought links.
    for (let i = 0; i < 8; i++) t[`slept badly ${i}`] = ['sleep', 0.88 - i * 0.01]
    const { capture, links, thoughtOf, h } = setup(t)
    const olds: string[] = []
    for (let i = 0; i < 8; i++) {
      olds.push(await capture(`note: slept badly ${i}`))
      h.clock.now += MIN
    }
    const n = await capture('note: sleep again')
    const id = thoughtOf(n)?.id
    const mine = links().filter((l) => l.a_thought_id === id || l.b_thought_id === id)
    expect(mine).toHaveLength(5)
    // Every thought stays within the cap.
    const counts = new Map<string, number>()
    for (const l of links()) {
      for (const x of [l.a_thought_id, l.b_thought_id]) counts.set(x, (counts.get(x) ?? 0) + 1)
    }
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(5)
  })

  test('links appear in the same pass as processing, before the reflective question', async () => {
    const { capture, links, llm, h } = setup(
      { 'worried about the rent': ['rent', 1], 'rent is late again': ['rent', 0.9] },
      { reflect: 'ask' },
    )
    await capture('worry: worried about the rent')
    h.clock.now += DAY
    const calls = llm.chatCalls.length
    const b = await capture('worry: rent is late again')
    const bullet = h.db.select().from(bullets).where(eq(bullets.id, b)).get()
    const [link] = links()
    expect(link).toBeDefined()
    expect((link?.created_at ?? 0) - (bullet?.proc_updated_at ?? 0)).toBeLessThanOrEqual(2 * MIN)
    // The reflective question came after the link job (which made no model call here).
    expect(
      llm.chatCalls
        .slice(calls)
        .map(sys)
        .filter((s) => s === REFLECT_SYSTEM_PROMPT),
    ).toHaveLength(1)
  })

  test('"Not related" deletes the link and survives edits, reprocessing and nightly runs', async () => {
    const { capture, links, op, edit, nightly, h, thoughtOf } = setup(table)
    const a = await capture('note: the rent is going up again')
    h.clock.now += DAY
    const b = await capture('note: the landlord wants more rent')
    const [link] = links()
    expect((await op({ type: 'link.veto', link_id: link?.id }))?.status).toBe('applied')
    expect(links()).toHaveLength(0)
    // Both directions.
    const [x, y] = [thoughtOf(a)?.id as string, thoughtOf(b)?.id as string]
    expect(isVetoed(h.db, h.ownerId, x, y, 'link')).toBe(true)
    expect(isVetoed(h.db, h.ownerId, y, x, 'link')).toBe(true)
    // An edit that keeps the thought, a retry-like reprocess, a nightly run: still no link.
    h.clock.now += MIN
    await edit(b, 'note: the landlord wants more rent | note: sunny day')
    await h.worker.drain()
    await nightly()
    expect(links()).toHaveLength(0)
    // The same veto again is harmless.
    expect((await op({ type: 'link.veto', link_id: link?.id }))?.status).toBe('duplicate')
  })

  test('deleting a capture takes its links away', async () => {
    const { capture, links, op, h } = setup(table)
    await capture('note: the rent is going up again')
    h.clock.now += DAY
    const b = await capture('note: the landlord wants more rent')
    expect(links()).toHaveLength(1)
    await op({ type: 'bullet.delete', bullet_id: b, mode: 'keep_extractions' })
    expect(links()).toHaveLength(0)
  })

  test('without an embedder nothing is linked and processing is unchanged', async () => {
    const h = createHarness(model(), {}, segment)
    await h.capture('note: the rent is going up again')
    await h.worker.drain()
    expect(h.db.select().from(bullets).get()?.proc_status).toBe('processed')
    expect(h.db.select().from(linkJobs).get()?.status).toBe('queued')
  })
})

// --- answered loops ---

describe('a later capture answering an open loop', () => {
  const table: Record<string, [string, number]> = {
    'check if the passport expires': ['passport', 1],
    'passport valid until 2029': ['passport', 0.74],
    'passport office is closed': ['passport', 0.72],
  }
  const answers = (_loop: string, later: string) => (later.includes('2029') ? 'yes' : 'no')

  test('exactly one thought_resolve at suggest; accept closes the loop, Undo reopens it', async () => {
    const { capture, resolves, links, op, thoughtOf, edit, h, llm } = setup(table, { answers })
    const a = await capture('to_check: check if the passport expires')
    h.clock.now += DAY
    const b = await capture('note: passport valid until 2029')
    const loop = thoughtOf(a)
    const [s] = resolves()
    expect(resolves()).toHaveLength(1)
    expect(s).toMatchObject({
      target_kind: 'thought_resolve',
      operation: 'update',
      target_id: loop?.id,
      tier: 'suggest',
      status: 'pending',
      source_bullet_id: b,
      source_thought_id: thoughtOf(b)?.id,
      payload: { thought_id: loop?.id, resolved_by_bullet_id: b },
    })
    expect(llm.chatCalls.filter((c) => sys(c) === ANSWER_CHECK_SYSTEM_PROMPT)).toHaveLength(1)
    // Linked as an answer (0.74 is under the link threshold: the yes made the link).
    expect(links().map((l) => l.type)).toEqual(['answers'])
    // It is about another capture's loop: the answering capture is not held in review.
    expect(h.db.select().from(bullets).where(eq(bullets.id, b)).get()?.proc_status).toBe(
      'processed',
    )

    // Reprocessing the answer adds nothing.
    h.clock.now += MIN
    await edit(b, 'note: passport valid until 2029 | note: good news')
    await h.worker.drain()
    expect(resolves()).toHaveLength(1)

    expect((await op({ type: 'suggestion.accept', suggestion_id: s?.id }))?.status).toBe('applied')
    expect(thoughtOf(a)).toMatchObject({ resolved_at: h.clock.now, resolved_by_bullet_id: b })
    expect((await op({ type: 'suggestion.undo', suggestion_id: s?.id }))?.status).toBe('applied')
    expect(thoughtOf(a)).toMatchObject({ resolved_at: null, resolved_by_bullet_id: null })
    // Undone stays undone: reprocessing does not propose it again.
    h.clock.now += MIN
    await edit(b, 'note: passport valid until 2029 | note: good news indeed')
    await h.worker.drain()
    expect(resolves().filter((r) => r.status === 'pending')).toHaveLength(0)
  })

  test('two thoughts of one capture answering the same loop still make one suggestion', async () => {
    const t = { ...table, 'passport renewed in 2029 too': ['passport', 0.74] as [string, number] }
    const { capture, resolves, h } = setup(t, { answers })
    await capture('to_check: check if the passport expires')
    h.clock.now += DAY
    await capture('note: passport valid until 2029 | note: passport renewed in 2029 too')
    expect(resolves()).toHaveLength(1)
  })

  test('dismissing vetoes the pair; reprocessing never proposes it again', async () => {
    const { capture, resolves, op, edit, h } = setup(table, { answers })
    await capture('to_check: check if the passport expires')
    h.clock.now += DAY
    const b = await capture('note: passport valid until 2029')
    const [s] = resolves()
    await op({ type: 'suggestion.reject', suggestion_id: s?.id })
    h.clock.now += MIN
    await edit(b, 'note: passport valid until 2029 | note: ok')
    await h.worker.drain()
    expect(resolves().map((r) => r.status)).toEqual(['rejected'])
  })

  test('accepting a loop closed meanwhile is refused (Already closed)', async () => {
    const { capture, resolves, op, thoughtOf, h } = setup(table, { answers })
    const a = await capture('to_check: check if the passport expires')
    h.clock.now += DAY
    await capture('note: passport valid until 2029')
    await op({ type: 'thought.resolve', thought_id: thoughtOf(a)?.id })
    const res = await op({ type: 'suggestion.accept', suggestion_id: resolves()[0]?.id })
    expect(res).toMatchObject({ status: 'rejected', error: { code: 'conflict' } })
  })

  test('a loop resolved by hand is untouched: no check, no suggestion', async () => {
    const { capture, resolves, op, thoughtOf, h, llm } = setup(table, { answers })
    const a = await capture('to_check: check if the passport expires')
    await op({ type: 'thought.resolve', thought_id: thoughtOf(a)?.id })
    h.clock.now += DAY
    await capture('note: passport valid until 2029')
    expect(resolves()).toHaveLength(0)
    expect(llm.chatCalls.filter((c) => sys(c) === ANSWER_CHECK_SYSTEM_PROMPT)).toHaveLength(0)
    expect(thoughtOf(a)?.resolved_by_bullet_id).toBeNull()
  })

  test('a "no" makes no suggestion, and a sensitive answer is never checked', async () => {
    const { capture, resolves, h, llm } = setup(table, { answers })
    await capture('to_check: check if the passport expires')
    h.clock.now += DAY
    await capture('note: passport office is closed')
    await capture('sensitive note: passport valid until 2029')
    expect(resolves()).toHaveLength(0)
    expect(llm.chatCalls.filter((c) => sys(c) === ANSWER_CHECK_SYSTEM_PROMPT)).toHaveLength(1)
  })
})

// --- connection questions ---

describe('"Is this the same thing?"', () => {
  const table: Record<string, [string, number]> = {
    'should I switch banks': ['bank', 1],
    'thinking about moving my account': ['bank', 0.7],
    'the bank fees went up': ['bank', 0.7],
  }

  test('takes the capture question slot only when reflection asked nothing', async () => {
    const { capture, reflective, thoughtOf, h } = setup(table)
    const a = await capture('question: should I switch banks')
    h.clock.now += DAY
    const b = await capture('idea: thinking about moving my account')
    const qs = reflective()
    expect(qs).toHaveLength(1)
    expect(qs[0]).toMatchObject({
      origin: 'connection',
      kind: 'reflective',
      options: [...CONNECTION_OPTIONS],
      source_bullet_id: b,
      source_thought_id: thoughtOf(b)?.id,
      related_thought_id: thoughtOf(a)?.id,
      text: 'Is this the same thing? «should I switch banks» / «thinking about moving my account»',
    })
  })

  test('replaces the reflective question, never adds to it', async () => {
    const { capture, reflective, h } = setup(table, { reflect: 'ask' })
    await capture('question: should I switch banks')
    const before = reflective().length
    h.clock.now += DAY
    const b = await capture('idea: thinking about moving my account')
    const mine = reflective().filter((q) => q.source_bullet_id === b)
    expect(mine).toHaveLength(1)
    expect(mine[0]?.origin).toBe('capture')
    expect(reflective()).toHaveLength(before + 1)
  })

  test('obeys the slice 2 limits', async () => {
    const { capture, reflective, h } = setup(table, { reflect: 'ask' })
    // Fill the open cap with reflective questions from unrelated worries.
    for (let i = 0; i < REFLECTIVE_CAPS.maxOpen; i++) {
      await capture(`worry: unrelated worry number ${i}`)
      h.clock.now += DAY
    }
    const open = reflective().length
    expect(open).toBe(REFLECTIVE_CAPS.maxOpen)
    await capture('question: should I switch banks')
    h.clock.now += DAY
    await capture('idea: thinking about moving my account')
    expect(reflective()).toHaveLength(open)
  })

  test('Same thing links them; Different remembers they are not', async () => {
    const { capture, reflective, links, op, thoughtOf, edit, h } = setup(table)
    const a = await capture('question: should I switch banks')
    h.clock.now += DAY
    await capture('idea: thinking about moving my account')
    const [q1] = reflective()
    expect(
      (await op({ type: 'question.answer', question_id: q1?.id, option: 'Same thing' }))?.status,
    ).toBe('applied')
    expect(links()).toEqual([
      expect.objectContaining({
        a_thought_id: thoughtOf(a)?.id,
        origin: 'user',
        type: 'same_topic',
      }),
    ])

    h.clock.now += DAY
    const c = await capture('worry: the bank fees went up')
    const q2 = reflective().find((q) => q.source_bullet_id === c)
    expect(q2?.origin).toBe('connection')
    await op({ type: 'question.answer', question_id: q2?.id, option: 'Different' })
    expect(
      isVetoed(h.db, h.ownerId, thoughtOf(a)?.id as string, thoughtOf(c)?.id as string, 'link'),
    ).toBe(true)
    // Reprocessing asks nothing new about it.
    h.clock.now += MIN
    await edit(c, 'worry: the bank fees went up | note: noted')
    await h.worker.drain()
    expect(reflective().filter((q) => q.source_bullet_id === c)).toHaveLength(1)
    // Options are for connection questions only.
    const other = await op({ type: 'question.answer', question_id: q2?.id, option: 'Maybe' })
    expect(other?.status).toBe('rejected')
  })

  test('never about a sensitive thought', async () => {
    const { capture, reflective, h } = setup(table)
    await capture('sensitive question: should I switch banks')
    h.clock.now += DAY
    await capture('idea: thinking about moving my account')
    expect(reflective()).toHaveLength(0)
  })
})

// --- themes and Noticed ---

/** `n` thoughts on `topic`, one capture a day starting at the clock. */
async function captureDays(
  s: ReturnType<typeof setup>,
  table: Record<string, [string, number]>,
  topic: string,
  days: number,
  opts: { sensitive?: (i: number) => boolean } = {},
) {
  const ids: string[] = []
  for (let i = 0; i < days; i++) {
    const text = `${topic} again, day ${i}`
    table[text] = [topic, 0.95]
    ids.push(await s.capture(`${opts.sensitive?.(i) ? 'sensitive ' : ''}note: ${text}`))
    s.h.clock.now += DAY
  }
  return ids
}

describe('themes', () => {
  test('≥ 4 thoughts over ≥ 3 days from ≥ 2 captures make a theme; fewer do not', async () => {
    const table: Record<string, [string, number]> = {}
    const s = setup(table, { name: () => 'rent' })
    await captureDays(s, table, 'rent', 3)
    await s.nightly()
    expect(s.h.db.select().from(themes).all()).toHaveLength(0)
    await captureDays(s, table, 'rent', 1)
    await s.nightly()
    const [t] = s.h.db.select().from(themes).all()
    expect(t).toMatchObject({
      status: 'active',
      thought_count: 4,
      day_count: 4,
      model_name: 'rent',
    })
    expect(s.h.db.select().from(themeThoughts).all()).toHaveLength(4)

    // Two thoughts a day for two days is 4 thoughts but only 2 days: no theme.
    const table2: Record<string, [string, number]> = {}
    const s2 = setup(table2)
    for (let d = 0; d < 2; d++) {
      for (const k of [0, 1]) {
        const text = `sleep, day ${d} part ${k}`
        table2[text] = ['sleep', 0.95]
        await s2.capture(`note: ${text}`)
      }
      s2.h.clock.now += DAY
    }
    await s2.nightly()
    expect(s2.h.db.select().from(themes).all()).toHaveLength(0)
  })

  test('the model name must be the user’s words; rename, retire and merge stick', async () => {
    const table: Record<string, [string, number]> = {}
    const s = setup(table, { name: () => 'You seem stressed about money' })
    await captureDays(s, table, 'rent', 4)
    await captureDays(s, table, 'bills', 4)
    await s.nightly()
    const all = () => s.h.db.select().from(themes).all()
    const rent = all().find((t) => t.model_name?.includes('rent'))
    const bills = all().find((t) => t.model_name?.includes('bills'))
    // The model's name was refused (not the user's words): the words the notes share instead.
    expect(rent?.model_name).toBe('rent')
    expect(bills?.model_name).toBe('bills')

    await s.op({ type: 'theme.rename', theme_id: rent?.id, name: 'Flat money' })
    await s.op({ type: 'theme.merge', theme_id: bills?.id, into_theme_id: rent?.id })
    await captureDays(s, table, 'bills', 1)
    await s.nightly()
    const after = new Map(all().map((t) => [t.id, t]))
    expect(after.get(rent?.id as string)).toMatchObject({
      user_name: 'Flat money',
      status: 'active',
    })
    expect(after.get(bills?.id as string)).toMatchObject({
      status: 'retired',
      retired_by: 'merge',
      merged_into_theme_id: rent?.id,
    })
    // The new bills thought folded into the survivor; no new theme.
    expect(all()).toHaveLength(2)
    const members = s.h.db
      .select()
      .from(themeThoughts)
      .where(and(eq(themeThoughts.theme_id, rent?.id as string), eq(themeThoughts.state, 'active')))
      .all()
    expect(members).toHaveLength(9)

    // "Not a theme": retired, and more of the same never re-creates it.
    await s.op({ type: 'theme.retire', theme_id: rent?.id })
    await captureDays(s, table, 'rent', 2)
    await s.nightly()
    expect(all().filter((t) => t.status === 'active')).toHaveLength(0)
    // Its links survive.
    expect(s.links().length).toBeGreaterThan(0)
  })

  test('Noticed: at most 2 a day, once per theme per 14 days, retired unopened after 14 days', async () => {
    const table: Record<string, [string, number]> = {}
    const s = setup(table)
    for (const topic of ['rent', 'sleep', 'karim']) await captureDays(s, table, topic, 4)
    await s.nightly()
    const cards = () => s.h.db.select().from(noticedCards).all()
    expect(cards()).toHaveLength(2)
    expect(cards()[0]?.headline).toMatch(/^«.+» · came up 4 times in 4 days$/)
    expect(cards()[0]?.quotes.length).toBeLessThanOrEqual(3)
    // Same day again: nothing more.
    s.h.clock.now += 2 * 60 * MIN
    await s.nightly()
    expect(cards()).toHaveLength(2)
    // Next day: the third theme's card; the first two wait 14 days.
    s.h.clock.now += DAY
    await s.nightly()
    expect(cards()).toHaveLength(3)
    s.h.clock.now += DAY
    await s.nightly()
    expect(cards()).toHaveLength(3)

    await s.op({ type: 'noticed.open', card_id: cards()[0]?.id })
    await s.op({ type: 'noticed.dismiss', card_id: cards()[1]?.id })
    s.h.clock.now += 14 * DAY
    // Keep the themes alive in the window.
    for (const topic of ['rent', 'sleep', 'karim']) await captureDays(s, table, topic, 4)
    await s.nightly()
    const byStatus = (st: string) => cards().filter((c) => c.status === st).length
    expect(byStatus('opened')).toBe(1)
    expect(byStatus('dismissed')).toBe(1)
    expect(byStatus('retired')).toBe(1)
    expect(cards().filter((c) => c.created_at === s.h.clock.now)).toHaveLength(2)
  })

  test('Not a theme withdraws its unopened cards', async () => {
    const table: Record<string, [string, number]> = {}
    const s = setup(table)
    await captureDays(s, table, 'rent', 4)
    await s.nightly()
    const [card] = s.h.db.select().from(noticedCards).all()
    await s.op({ type: 'theme.retire', theme_id: card?.theme_id })
    expect(s.h.db.select().from(noticedCards).get()?.status).toBe('retired')
  })

  test('a week offline: one catch-up run, within every cap', async () => {
    const table: Record<string, [string, number]> = {}
    const llm = model()
    const embedder = topicEmbedder(table)
    const s = setup(table)
    // Ten recurring topics over a week, with no nightly run.
    const topics = Array.from({ length: 10 }, (_, i) => `topic${i}`)
    for (let d = 0; d < 7; d++) {
      for (const topic of topics) {
        const text = `${topic} on day ${d}`
        table[text] = [topic, 0.95]
        await s.h.capture(`note: ${text}`, { captured_at: s.h.clock.now })
      }
      s.h.clock.now += DAY
    }
    await s.h.worker.drain()
    // The server comes back: its worker runs the nightly once.
    const worker = (await import('../queue/worker')).createWorker({
      db: s.h.db,
      llm,
      engine: s.h.engine,
      now: () => s.h.clock.now,
      embedder,
      embedProfile: DEDICATED_PROFILE,
      nightly: { timezone: 'UTC' },
    })
    expect(nightlyDue(s.h.db, s.h.clock.now, 'UTC')).not.toBeNull()
    await worker.drain()
    expect(nightlyDue(s.h.db, s.h.clock.now, 'UTC')).toBeNull()
    const active = s.h.db.select().from(themes).where(eq(themes.status, 'active')).all()
    expect(active).toHaveLength(8)
    expect(s.h.db.select().from(noticedCards).all()).toHaveLength(2)
    // Draining again the same night does nothing more.
    await worker.drain()
    expect(s.h.db.select().from(noticedCards).all()).toHaveLength(2)
  })
})

// --- sensitive ---

describe('sensitive thoughts never surface outside their own capture', () => {
  test('links to them are not pulled; mostly-sensitive themes get no card and are not pulled', async () => {
    const table: Record<string, [string, number]> = {}
    const s = setup(table)
    // 3 of 4 sensitive: a theme on the server, nothing on the phone.
    await captureDays(s, table, 'dark', 4, { sensitive: (i) => i > 0 })
    // 1 of 4 sensitive: a card, never quoting it.
    await captureDays(s, table, 'work', 4, { sensitive: (i) => i === 0 })
    await s.nightly()
    const all = s.h.db.select().from(themes).all()
    expect(all).toHaveLength(2)
    const dark = all.find((t) => t.sensitive_share >= 0.5)
    expect(dark?.model_name).toBeNull()
    const cards = s.h.db.select().from(noticedCards).all()
    expect(cards).toHaveLength(1)
    expect(cards[0]?.theme_id).not.toBe(dark?.id)
    const sensitiveIds = new Set(
      s.h.db
        .select()
        .from(thoughts)
        .where(eq(thoughts.sensitive, true))
        .all()
        .map((t) => t.id),
    )
    expect(cards[0]?.quotes.some((q) => sensitiveIds.has(q.thought_id))).toBe(false)
    expect(cards[0]?.headline).toContain('came up 3 times')

    const pull = pullResponseSchema.parse(await s.h.pull())
    const shown = pull.changes.thought_links.filter((l) => l.state === 'active')
    expect(
      shown.some((l) => sensitiveIds.has(l.a_thought_id) || sensitiveIds.has(l.b_thought_id)),
    ).toBe(false)
    expect(shown.length).toBeGreaterThan(0)
    expect(pull.changes.themes.find((t) => t.id === dark?.id)?.state).toBe('deleted')
    expect(
      pull.changes.theme_thoughts.filter(
        (m) => m.state === 'active' && (m.theme_id === dark?.id || sensitiveIds.has(m.thought_id)),
      ),
    ).toHaveLength(0)
    expect(pull.changes.noticed_cards.filter((c) => c.state === 'active')).toHaveLength(1)
    // The flag and the entities never leave the server.
    const raw = (await (
      await s.h.request('/sync/pull', { headers: { authorization: `Bearer ${s.h.token}` } })
    ).json()) as { changes: { thoughts: Record<string, unknown>[] } }
    expect(raw.changes.thoughts.every((t) => !('sensitive' in t) && !('entities' in t))).toBe(true)
  })
})
