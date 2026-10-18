import { pullResponseSchema } from '@bullet/core'
import { describe, expect, test } from 'vite-plus/test'
import { questions, suggestions, tasks, thoughts } from '../db/schema'
import { candidate, createHarness, llmByText, type SegmentScript, T0, uid } from '../test/helpers'

const RAMBLE =
  "I'm worried about the rent. Dentist Thursday. Call the landlord tomorrow. Maybe a garden on the roof?"

const segment: SegmentScript = () => [
  { text: "I'm worried about the rent", quote: "I'm worried about the rent.", kind: 'worry' },
  { text: 'Dentist Thursday', quote: 'Dentist Thursday.', kind: 'event' },
  { text: 'Call the landlord tomorrow', quote: 'Call the landlord tomorrow.', kind: 'task' },
  { text: 'Maybe a garden on the roof?', quote: 'Maybe a garden on the roof?', kind: 'idea' },
]

const llm = () =>
  llmByText({
    Dentist: [
      candidate({
        kind: 'event',
        orientation: 'future_oneoff',
        fields: { title: 'Dentist', when: 'Thursday' },
      }),
    ],
    landlord: [
      candidate({
        kind: 'task',
        orientation: 'future_oneoff',
        fields: { title: 'Call the landlord', when: 'tomorrow' },
      }),
    ],
  })

describe('capture → thoughts → things', () => {
  test('every thought is kept, things link to their thought, questions are pulled', async () => {
    const h = createHarness(llm(), {}, segment)
    const b = await h.capture(RAMBLE)
    await h.worker.drain()

    const ts = h.db
      .select()
      .from(thoughts)
      .all()
      .sort((a, b) => a.position - b.position)
    expect(ts.map((t) => [t.kind, t.kind_source])).toEqual([
      ['worry', 'engine'],
      ['event', 'engine'],
      ['task', 'engine'],
      ['idea', 'engine'],
    ])
    expect(RAMBLE.slice(ts[0]?.span_start ?? 0, ts[0]?.span_end ?? 0)).toBe(
      "I'm worried about the rent.",
    )

    const ss = h.db.select().from(suggestions).all()
    expect(ss.map((s) => [s.target_kind, s.source_thought_id])).toEqual([
      ['event', ts[1]?.id],
      ['task', ts[2]?.id],
    ])
    // Provenance is also on the payload, so the applied thing carries it.
    const task = ss.find((s) => s.target_kind === 'task')
    expect(task?.payload.source_thought_id).toBe(ts[2]?.id)
    await h.push([{ op_id: uid(), type: 'suggestion.accept', suggestion_id: task?.id ?? '' }])
    expect(h.db.select().from(tasks).get()).toMatchObject({
      source_bullet_id: b,
      source_thought_id: ts[2]?.id,
    })

    // "Dentist Thursday" said on a Thursday → one clarifying question about the event.
    const [q] = h.db.select().from(questions).all()
    expect(q).toMatchObject({
      kind: 'clarifying',
      topic: 'date',
      status: 'open',
      source_thought_id: ts[1]?.id,
      suggestion_id: ss[0]?.id,
      options: ['Today', 'Next Thursday'],
    })

    const pulled = pullResponseSchema.parse(await h.pull())
    expect(pulled.changes.thoughts).toHaveLength(4)
    expect(pulled.changes.thoughts.find((t) => t.kind === 'worry')?.span).toEqual({
      start: 0,
      end: 27,
    })
    expect(pulled.changes.questions).toHaveLength(1)
  })

  test('a capture with nothing actionable still keeps its thoughts → processed', async () => {
    const h = createHarness(llmByText({}), {}, () => [
      { text: 'feeling a bit low today', kind: 'note' },
    ])
    await h.capture('feeling a bit low today')
    await h.worker.drain()
    expect(h.db.select().from(thoughts).all()).toHaveLength(1)
    expect(h.db.select().from(suggestions).all()).toHaveLength(0)
  })

  test('re-classifying is sticky across re-processing (edit)', async () => {
    let text = 'worried about the rent'
    const h = createHarness(llmByText({}), {}, () => [{ text, kind: 'worry' }])
    const b = await h.capture('worried about the rent')
    await h.worker.drain()
    const t = h.db.select().from(thoughts).get()
    await h.push([
      { op_id: uid(), type: 'thought.reclassify', thought_id: t?.id ?? '', kind: 'to_check' },
    ])
    expect(h.db.select().from(thoughts).get()).toMatchObject({
      kind: 'to_check',
      kind_source: 'user',
    })

    text = 'worried about the rent'
    await h.push([
      {
        op_id: uid(),
        type: 'bullet.edit',
        bullet_id: b,
        text: 'worried about the rent!',
        edited_at: T0 + 1,
      },
    ])
    await h.worker.drain()
    const live = h.db
      .select()
      .from(thoughts)
      .all()
      .filter((x) => x.state === 'active')
    expect(live).toMatchObject([{ id: t?.id, kind: 'to_check', kind_source: 'user' }])
  })

  test('an edit retires thoughts that disappeared', async () => {
    let parts = ['a thought', 'another thought']
    const h = createHarness(llmByText({}), {}, () =>
      parts.map((text) => ({ text, kind: 'note' as const })),
    )
    const b = await h.capture('a thought. another thought')
    await h.worker.drain()
    parts = ['a thought']
    await h.push([
      { op_id: uid(), type: 'bullet.edit', bullet_id: b, text: 'a thought', edited_at: T0 + 1 },
    ])
    await h.worker.drain()
    const all = h.db.select().from(thoughts).all()
    expect(all.filter((t) => t.state === 'active').map((t) => t.text)).toEqual(['a thought'])
    expect(all.find((t) => t.text === 'another thought')?.state).toBe('deleted')
  })
})

describe('clarifying questions', () => {
  const dentist = () =>
    llmByText({
      Dentist: [
        candidate({
          kind: 'event',
          orientation: 'future_oneoff',
          fields: { title: 'Dentist', when: 'Thursday' },
        }),
      ],
    })
  const seg: SegmentScript = (c) => [{ text: c, kind: 'event' }]

  test('dismiss → dismissed, and it is not asked again after an edit', async () => {
    const h = createHarness(dentist(), {}, seg)
    const b = await h.capture('Dentist Thursday')
    await h.worker.drain()
    const q = h.db.select().from(questions).get()
    await h.push([{ op_id: uid(), type: 'question.dismiss', question_id: q?.id ?? '' }])
    expect(h.db.select().from(questions).get()).toMatchObject({ status: 'dismissed' })
    await h.push([
      {
        op_id: uid(),
        type: 'bullet.edit',
        bullet_id: b,
        text: 'Dentist Thursday!',
        edited_at: T0 + 1,
      },
    ])
    await h.worker.drain()
    expect(
      h.db
        .select()
        .from(questions)
        .all()
        .filter((x) => x.status === 'open'),
    ).toHaveLength(0)
  })

  test('answering is a capture linked to the question', async () => {
    const h = createHarness(dentist(), {}, seg)
    await h.capture('Dentist Thursday')
    await h.worker.drain()
    const q = h.db.select().from(questions).get()
    const answer = await h.capture('next week', { answers_question_id: q?.id })
    expect(h.db.select().from(questions).get()).toMatchObject({
      status: 'answered',
      answer_bullet_id: answer,
    })
    const pulled = await h.pull()
    expect(pulled.changes.bullets.find((x) => x.id === answer)?.answers_question_id).toBe(q?.id)
  })

  test('open questions do not block: the bullet status follows suggestions only', async () => {
    const h = createHarness(dentist(), {}, seg)
    await h.capture('Dentist Thursday')
    await h.worker.drain()
    const s = h.db.select().from(suggestions).get()
    await h.push([{ op_id: uid(), type: 'suggestion.accept', suggestion_id: s?.id ?? '' }])
    const pulled = await h.pull()
    expect(pulled.changes.bullets[0]?.processing.status).toBe('processed')
    expect(pulled.changes.questions[0]?.status).toBe('open')
  })

  test('deleting the capture withdraws its thoughts and questions', async () => {
    const h = createHarness(dentist(), {}, seg)
    const b = await h.capture('Dentist Thursday')
    await h.worker.drain()
    await h.push([{ op_id: uid(), type: 'bullet.delete', bullet_id: b, mode: 'keep_extractions' }])
    expect(
      h.db
        .select()
        .from(thoughts)
        .all()
        .every((t) => t.state === 'deleted'),
    ).toBe(true)
    expect(
      h.db
        .select()
        .from(questions)
        .all()
        .every((t) => t.state === 'deleted'),
    ).toBe(true)
  })
})
