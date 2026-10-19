import { zonedToEpoch } from '@bullet/engine'
import { describe, expect, test } from 'vite-plus/test'
import { bullets, events, questions, suggestions, trackerEntries, trackers } from '../db/schema'
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

  test('new tracker: "No" dismisses the tracker suggestion', async () => {
    const h = createHarness(llm())
    const q = await questionFor(h, 'slept 6 hours')
    await h.push([answer(q.id, 'No')])
    const all = h.db.select().from(suggestions).all()
    expect(all.find((s) => s.target_kind === 'tracker')?.status).toBe('rejected')
    // "Not now": the reading that waited on it goes too (the thought keeps the words).
    expect(all.find((s) => s.target_kind === 'tracker_entry')?.status).toBe('rejected')
    expect(h.db.select().from(bullets).get()?.proc_status).toBe('processed')
    expect(h.db.select().from(trackers).all()).toHaveLength(0)
    expect(h.db.select().from(questions).get()?.answer_option).toBe('No')
  })
})
