import { zonedToEpoch } from '@bullet/engine'
import { describe, expect, test } from 'vite-plus/test'
import { eq } from 'drizzle-orm'
import {
  activities,
  bullets,
  events,
  questions,
  suggestions,
  trackerEntries,
  trackers,
} from '../db/schema'
import { candidate, createHarness, llmByText, uid } from '../test/helpers'

const paris = (day: number, hour: number) =>
  zonedToEpoch({ year: 2026, month: 10, day, hour, minute: 0 }, 'Europe/Paris')

// Captured on Thursday 2026-10-15: "Thursday" is ambiguous → "Which Thursday?".
const llm = () =>
  llmByText({
    Dentist: [
      candidate({
        kind: 'event',
        orientation: 'future_oneoff',
        fields: { title: 'Dentist', when: 'Thursday 3pm' },
      }),
    ],
    slept: [
      candidate({
        kind: 'tracker_entry',
        orientation: 'happened',
        fields: { name: 'sleep', value: 6, unit: 'hours' },
      }),
    ],
  })

async function questionFor(h: ReturnType<typeof createHarness>, text: string) {
  await h.capture(text)
  await h.worker.drain()
  const q = h.db.select().from(questions).get()
  if (!q) throw new Error('no question')
  return q
}

const answer = (question_id: string, option: string) => ({
  op_id: uid(),
  type: 'question.answer' as const,
  question_id,
  option,
})

describe('answering a clarifying question by tapping an option', () => {
  test('date: the tapped day goes on the event, which is applied (and undoable)', async () => {
    const h = createHarness(llm())
    const q = await questionFor(h, 'Dentist Thursday 3pm')
    expect(q.options).toEqual(['Today', 'Next Thursday'])
    const res = await h.push([answer(q.id, 'Next Thursday')])
    expect(res.results[0]?.status).toBe('applied')

    expect(h.db.select().from(events).get()).toMatchObject({
      title: 'Dentist',
      starts_at: paris(22, 15),
      state: 'active',
    })
    const s = h.db.select().from(suggestions).get()
    expect(s).toMatchObject({ status: 'edited', auto_applied: false, applied_entity_id: s?.id })
    expect(s?.payload.starts_at).toBe(paris(22, 15))
    expect(h.db.select().from(questions).get()).toMatchObject({
      status: 'answered',
      answer_option: 'Next Thursday',
    })
    expect(h.db.select().from(bullets).get()?.proc_status).toBe('processed')

    // The same answer again is harmless; a different one is refused.
    const again = await h.push([answer(q.id, 'Next Thursday'), answer(q.id, 'Today')])
    expect(again.results.map((r) => (r.status === 'rejected' ? r.error.code : r.status))).toEqual([
      'duplicate',
      'invalid',
    ])
    // Undo is available like for anything applied.
    const undo = await h.push([
      { op_id: uid(), type: 'suggestion.undo', suggestion_id: s?.id ?? '' },
    ])
    expect(undo.results[0]?.status).toBe('applied')
    expect(h.db.select().from(events).get()?.state).toBe('deleted')
  })

  test('date: an already-applied suggestion has its result moved, keeping Undo', async () => {
    const h = createHarness(llm())
    const q = await questionFor(h, 'Dentist Thursday 3pm')
    const s = h.db.select().from(suggestions).get()
    await h.push([{ op_id: uid(), type: 'suggestion.accept', suggestion_id: s?.id ?? '' }])
    h.clock.now += 1_000
    await h.push([answer(q.id, 'Next Thursday')])
    expect(h.db.select().from(events).get()?.starts_at).toBe(paris(22, 15))
    const undo = await h.push([
      { op_id: uid(), type: 'suggestion.undo', suggestion_id: s?.id ?? '' },
    ])
    expect(undo.results[0]?.status).toBe('applied')
  })

  test('date: refused when the suggestion was dismissed, or for an option not offered', async () => {
    const h = createHarness(llm())
    const q = await questionFor(h, 'Dentist Thursday 3pm')
    const s = h.db.select().from(suggestions).get()
    const res = await h.push([
      answer(q.id, 'Tomorrow'),
      { op_id: uid(), type: 'suggestion.reject', suggestion_id: s?.id ?? '' },
      answer(q.id, 'Today'),
    ])
    expect(res.results.map((r) => (r.status === 'rejected' ? r.error.code : r.status))).toEqual([
      'invalid',
      'applied',
      'conflict',
    ])
    expect(h.db.select().from(questions).get()?.status).toBe('open')
  })

  test('new tracker: "Yes" creates the tracker (never on its own) and logs the reading', async () => {
    const h = createHarness(llm())
    const q = await questionFor(h, 'slept 6 hours')
    expect(q).toMatchObject({ topic: 'new_tracker', options: ['Yes', 'No'] })
    const tracker = h.db
      .select()
      .from(suggestions)
      .all()
      .find((s) => s.target_kind === 'tracker')
    expect(tracker?.id).toBe(q.suggestion_id)
    expect(h.db.select().from(trackers).all()).toHaveLength(0)

    // The reading waits on the tracker: a tracker entry pointing at the tracker suggestion.
    const reading = h.db
      .select()
      .from(suggestions)
      .all()
      .find((s) => s.target_kind === 'tracker_entry')
    expect(reading).toMatchObject({
      operation: 'create',
      tier: 'suggest',
      status: 'pending',
      payload: { tracker_id: tracker?.id, value: 6 },
    })
    expect(q.text).toBe('Start tracking Sleep?')

    await h.push([answer(q.id, 'Yes')])
    expect(h.db.select().from(trackers).get()).toMatchObject({
      id: tracker?.id,
      name: 'Sleep',
      input_type: 'number',
      config: { input_type: 'number', unit: 'h' },
    })
    const after = h.db.select().from(suggestions).all()
    expect(after.find((s) => s.target_kind === 'tracker')).toMatchObject({
      status: 'accepted',
      auto_applied: false,
    })
    expect(after.find((s) => s.target_kind === 'tracker_entry')).toMatchObject({
      status: 'accepted',
      auto_applied: false,
    })
    expect(h.db.select().from(trackerEntries).get()).toMatchObject({
      tracker_id: tracker?.id,
      value: 6,
    })
    expect(after.some((s) => s.target_kind === 'activity')).toBe(false)
    expect(h.db.select().from(bullets).get()?.proc_status).toBe('processed')
  })

  test('new tracker: accepted with an edited name ("Start tracking" in the Inbox)', async () => {
    const h = createHarness(llm())
    await questionFor(h, 'slept 6 hours')
    const tracker = h.db
      .select()
      .from(suggestions)
      .all()
      .find((s) => s.target_kind === 'tracker')!
    await h.push([
      {
        op_id: uid(),
        type: 'suggestion.accept',
        suggestion_id: tracker.id,
        payload: { ...tracker.payload, name: 'Night sleep' },
      },
    ])
    expect(h.db.select().from(trackers).get()?.name).toBe('Night sleep')
    expect(h.db.select().from(trackerEntries).get()?.value).toBe(6)
    // Its "Start tracking …?" question is answered by the card's decision.
    expect(h.db.select().from(questions).get()).toMatchObject({
      status: 'answered',
      answer_option: 'Yes',
    })
    // Undo takes the reading logged with it along.
    await h.push([{ op_id: uid(), type: 'suggestion.undo', suggestion_id: tracker.id }])
    expect(h.db.select().from(trackers).get()?.state).toBe('deleted')
    expect(h.db.select().from(trackerEntries).get()?.state).toBe('deleted')
  })

  test('new tracker: "No" keeps the reading as an activity with its value', async () => {
    const h = createHarness(llm())
    const q = await questionFor(h, 'slept 6 hours')
    await h.push([answer(q.id, 'No')])
    const all = h.db.select().from(suggestions).all()
    expect(all.find((s) => s.target_kind === 'tracker')?.status).toBe('rejected')
    // "Not now": the reading that waited on it is kept as a plain activity, applied as a record.
    const kept = all.find((s) => s.target_kind === 'activity')
    expect(kept).toMatchObject({ status: 'accepted', auto_applied: false })
    expect(all.some((s) => s.target_kind === 'tracker_entry')).toBe(false)
    expect(h.db.select().from(activities).get()).toMatchObject({
      tracker_id: null,
      quantity: 6,
      unit: 'h',
      state: 'active',
    })
    expect(h.db.select().from(bullets).get()?.proc_status).toBe('processed')
    expect(h.db.select().from(trackers).all()).toHaveLength(0)
    expect(h.db.select().from(questions).get()?.answer_option).toBe('No')
  })

  test('a declined offer never comes back when the capture is processed again', async () => {
    const h = createHarness(llm())
    const q = await questionFor(h, 'slept 6 hours')
    const b = h.db.select().from(bullets).get()!
    await h.push([answer(q.id, 'No')])
    await h.push([
      {
        op_id: uid(),
        type: 'bullet.edit',
        bullet_id: b.id,
        text: 'slept 6 hours!',
        edited_at: b.text_updated_at + 1,
      },
    ])
    await h.worker.drain()
    const live = h.db
      .select()
      .from(suggestions)
      .all()
      .filter((s) => s.state === 'active')
    expect(
      live.map((s) => [s.target_kind, s.status]).sort((x, y) => String(x).localeCompare(String(y))),
    ).toEqual([
      ['activity', 'accepted'],
      ['tracker', 'rejected'],
    ])
    expect(
      h.db
        .select()
        .from(activities)
        .all()
        .filter((a) => a.state === 'active'),
    ).toHaveLength(1)
    expect(
      h.db
        .select()
        .from(questions)
        .all()
        .filter((x) => x.status === 'open'),
    ).toEqual([])
  })
})

test('a declined offer stays declined when re-processing renames its tracker', async () => {
  const h = createHarness(
    llmByText({
      'at night': [
        candidate({
          kind: 'tracker_entry',
          text: 'slept 6 hours at night',
          fields: { tracker: 'night sleep', value: 6, unit: 'hours' },
        }),
      ],
      slept: [
        candidate({
          kind: 'tracker_entry',
          text: 'slept 6 hours',
          fields: { tracker: 'sleep', value: 6, unit: 'hours' },
        }),
      ],
    }),
  )
  const id = await h.capture('slept 6 hours')
  await h.worker.drain()
  const q = h.db.select().from(questions).get()!
  await h.push([answer(q.id, 'No')])
  const b = h.db.select().from(bullets).get()!
  await h.push([
    {
      op_id: uid(),
      type: 'bullet.edit',
      bullet_id: id,
      text: 'slept 6 hours at night',
      edited_at: b.text_updated_at + 1,
    },
  ])
  await h.worker.drain()
  const live = h.db
    .select()
    .from(suggestions)
    .all()
    .filter((s) => s.state === 'active')
  expect(live.find((s) => s.target_kind === 'tracker')?.status).toBe('rejected')
  expect(live.some((s) => s.target_kind === 'tracker_entry')).toBe(false)
  expect(live.find((s) => s.target_kind === 'activity')?.status).toBe('accepted')
})

describe('the same new tracker offered by two captures', () => {
  const sleepLlm = () =>
    llmByText({
      'slept 6': [
        candidate({
          kind: 'tracker_entry',
          text: 'slept 6 hours',
          fields: { tracker: 'sleep', value: 6, unit: 'hours' },
        }),
      ],
      'slept 7': [
        candidate({
          kind: 'tracker_entry',
          text: 'slept 7 hours',
          fields: { tracker: 'sleep', value: 7, unit: 'hours' },
        }),
      ],
    })
  const tracker = (s: typeof suggestions.$inferSelect) => s.target_kind === 'tracker'
  const of = (h: ReturnType<typeof createHarness>, bullet: string) =>
    h.db
      .select()
      .from(suggestions)
      .all()
      .filter((s) => s.source_bullet_id === bullet && s.state === 'active')

  async function twoCaptures() {
    const h = createHarness(sleepLlm())
    const a = await h.capture('slept 6 hours')
    const b = await h.capture('slept 7 hours')
    await h.worker.drain()
    return { h, a, b }
  }

  test('accepting A turns B into its own reading: "Log 7 h to Sleep?"', async () => {
    const { h, a, b } = await twoCaptures()
    const offerA = of(h, a).find(tracker)!
    const offerB = of(h, b).find(tracker)!
    // Before any acceptance they stay separate: "Not now" on one never decides the other.
    expect(offerA.id).not.toBe(offerB.id)
    await h.push([{ op_id: uid(), type: 'suggestion.accept', suggestion_id: offerA.id }])
    expect(h.db.select().from(trackers).all()).toHaveLength(1)
    const bNow = of(h, b)
    expect(bNow.find(tracker)).toMatchObject({
      status: 'accepted',
      applied_entity_id: offerA.id,
      auto_applied: false,
    })
    const readingB = bNow.find((s) => s.target_kind === 'tracker_entry')!
    expect(readingB).toMatchObject({
      status: 'pending',
      payload: { tracker_id: offerA.id, value: 7 },
    })
    expect(h.db.select().from(bullets).where(eq(bullets.id, b)).get()?.proc_status).toBe(
      'needs_review',
    )
    // B's question is answered with A's decision; its reading is decided on its own.
    expect(
      h.db
        .select()
        .from(questions)
        .all()
        .filter((q) => q.source_bullet_id === b)
        .map((q) => q.status),
    ).toEqual(['answered'])
    await h.push([{ op_id: uid(), type: 'suggestion.accept', suggestion_id: readingB.id }])
    expect(
      h.db
        .select()
        .from(trackerEntries)
        .all()
        .map((e) => [e.tracker_id, e.value])
        .sort((x, y) => Number(x[1]) - Number(y[1])),
    ).toEqual([
      [offerA.id, 6],
      [offerA.id, 7],
    ])
  })

  test('cross-device race: B accepted by a phone that has not heard of A yet', async () => {
    const { h, a, b } = await twoCaptures()
    const offerA = of(h, a).find(tracker)!
    const offerB = of(h, b).find(tracker)!
    await h.push([{ op_id: uid(), type: 'suggestion.accept', suggestion_id: offerA.id }])
    // The second phone still shows B's "Start tracking Sleep?" and taps it.
    const res = await h.push([
      { op_id: uid(), type: 'suggestion.accept', suggestion_id: offerB.id },
    ])
    expect(res.results[0]?.status).toBe('duplicate')
    expect(h.db.select().from(trackers).all()).toHaveLength(1)
    expect(of(h, b).find((s) => s.target_kind === 'tracker_entry')?.status).toBe('pending')
  })

  test('an offer accepted with the name of an existing tracker is linked, not refused', async () => {
    const { h, a, b } = await twoCaptures()
    const offerA = of(h, a).find(tracker)!
    const offerB = of(h, b).find(tracker)!
    await h.push([
      {
        op_id: uid(),
        type: 'suggestion.accept',
        suggestion_id: offerA.id,
        payload: { ...offerA.payload, name: 'Night sleep' },
      },
    ])
    // B was offered as "Sleep": a different name, so it is still open.
    expect(of(h, b).find(tracker)?.status).toBe('pending')
    const res = await h.push([
      {
        op_id: uid(),
        type: 'suggestion.accept',
        suggestion_id: offerB.id,
        payload: { ...offerB.payload, name: 'night SLEEP' },
      },
    ])
    expect(res.results[0]?.status).toBe('applied')
    expect(h.db.select().from(trackers).all()).toHaveLength(1)
    expect(of(h, b).find((s) => s.target_kind === 'tracker_entry')).toMatchObject({
      status: 'pending',
      payload: { tracker_id: offerA.id },
    })
  })

  test('undo never deletes a tracker it did not create', async () => {
    const { h, a, b } = await twoCaptures()
    const offerA = of(h, a).find(tracker)!
    const offerB = of(h, b).find(tracker)!
    await h.push([{ op_id: uid(), type: 'suggestion.accept', suggestion_id: offerA.id }])
    const undoB = await h.push([
      { op_id: uid(), type: 'suggestion.undo', suggestion_id: offerB.id },
    ])
    expect(undoB.results[0]?.status).toBe('applied')
    expect(h.db.select().from(trackers).get()?.state).toBe('active')
    // B's reading, logged to it, means A's tracker can't be undone from under it.
    const readingB = of(h, b).find((s) => s.target_kind === 'tracker_entry')!
    await h.push([{ op_id: uid(), type: 'suggestion.accept', suggestion_id: readingB.id }])
    const undoA = await h.push([
      { op_id: uid(), type: 'suggestion.undo', suggestion_id: offerA.id },
    ])
    expect(undoA.results[0]).toMatchObject({ status: 'rejected', error: { code: 'conflict' } })
    expect(h.db.select().from(trackers).get()?.state).toBe('active')
  })

  test("undoing A before acting on B opens B's offer again, which then creates the tracker", async () => {
    const { h, a, b } = await twoCaptures()
    const offerA = of(h, a).find(tracker)!
    const offerB = of(h, b).find(tracker)!
    await h.push([{ op_id: uid(), type: 'suggestion.accept', suggestion_id: offerA.id }])
    expect(of(h, b).find(tracker)?.status).toBe('accepted')
    const undo = await h.push([{ op_id: uid(), type: 'suggestion.undo', suggestion_id: offerA.id }])
    expect(undo.results[0]?.status).toBe('applied')
    expect(h.db.select().from(trackers).get()?.state).toBe('deleted')
    // B is "Start tracking Sleep?" again, with its reading waiting on it.
    expect(of(h, b).find(tracker)).toMatchObject({
      status: 'pending',
      applied_entity_id: null,
      applied_at: null,
      applied_after: null,
    })
    const readingB = of(h, b).find((s) => s.target_kind === 'tracker_entry')!
    expect(readingB).toMatchObject({ status: 'pending', payload: { tracker_id: offerB.id } })
    const qB = h.db
      .select()
      .from(questions)
      .all()
      .find((q) => q.source_bullet_id === b)
    expect(qB).toMatchObject({ status: 'open', answer_option: null })
    // Accepting B now creates the tracker and logs 7 h.
    await h.push([{ op_id: uid(), type: 'suggestion.accept', suggestion_id: offerB.id }])
    const live = h.db
      .select()
      .from(trackers)
      .all()
      .filter((t) => t.state === 'active')
    expect(live.map((t) => t.id)).toEqual([offerB.id])
    expect(
      h.db
        .select()
        .from(trackerEntries)
        .all()
        .filter((e) => e.state === 'active')
        .map((e) => [e.tracker_id, e.value]),
    ).toEqual([[offerB.id, 7]])
  })

  test('undo of a tracker is refused when its reading was edited by hand', async () => {
    const h = createHarness(sleepLlm())
    const a = await h.capture('slept 6 hours')
    await h.worker.drain()
    const offerA = of(h, a).find(tracker)!
    await h.push([{ op_id: uid(), type: 'suggestion.accept', suggestion_id: offerA.id }])
    const entry = h.db.select().from(trackerEntries).get()!
    h.clock.now += 1_000
    await h.push([
      {
        op_id: uid(),
        type: 'tracker_entry.update',
        tracker_entry_id: entry.id,
        patch: { value: 5 },
      },
    ])
    const undo = await h.push([{ op_id: uid(), type: 'suggestion.undo', suggestion_id: offerA.id }])
    expect(undo.results[0]).toMatchObject({ status: 'rejected', error: { code: 'conflict' } })
    expect(h.db.select().from(trackers).get()?.state).toBe('active')
    expect(h.db.select().from(trackerEntries).get()).toMatchObject({ value: 5, state: 'active' })
  })
})
