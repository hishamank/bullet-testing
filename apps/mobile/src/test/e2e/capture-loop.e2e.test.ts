/**
 * Slice 1, end to end, against a REAL home server. Skipped unless BULLET_E2E_URL is set.
 *
 *   BULLET_E2E_URL=http://127.0.0.1:3001 BULLET_E2E_TOKEN=… pnpm --filter mobile exec vp test run src/test/e2e
 *
 * Optional: BULLET_E2E_SPEECH_WAV (+ BULLET_E2E_SPEECH_WORDS), BULLET_E2E_LLM_STOP /
 * BULLET_E2E_LLM_START, BULLET_E2E_REPORT, BULLET_E2E_TZ. Point it at a
 * throwaway database: it writes made-up captures. See docs/e2e-results.md.
 *
 * Contract invariants are asserted; the model's judgement (kinds, dates, names) is recorded as
 * quality notes instead, so a small model's wobble shows in the report without failing the run.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PushOp } from '@bullet/core'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test'
import { decideHeld, releaseHolds, retractDecision } from '../../data/decisions'
import {
  acceptSuggestion,
  answerQuestion,
  captureBullet,
  captureVoiceBullet,
  dismissQuestion,
  editBullet,
  rejectSuggestion,
  reclassifyThought,
  resolveThought,
  retryBullet,
  undoSuggestion,
  unresolveThought,
  updateEvent,
  updateTask,
  updateTrackerEntry,
} from '../../data/local'
import { listOpenQuestions, listThoughts } from '../../data/queries'
import {
  activities,
  audioAttachments,
  bullets,
  events,
  outbox,
  questions,
  suggestions,
  tasks,
  thoughts,
  trackerEntries,
  trackers,
  transcripts,
} from '../../data/schema'
import { TransportError, type SyncTransport } from '../../sync/transport'
import { captureCounts } from '../../features/capture/counts'
import { captureNotice } from '../../features/capture/notice'
import {
  createPhone,
  E2E,
  enabled,
  isSettled,
  type Phone,
  quality,
  readBytes,
  record,
  runShell,
  sha256,
  syncUntil,
  toneWav,
  waitForHttp,
  wavDurationMs,
  zoned,
} from './harness'

const MIN = 60_000
/** A typed capture with several thoughts: one LLM call to split, one per actionable thought. */
const CAPTURE_TIMEOUT = 15 * MIN

const suggestionsOf = (p: Phone, bulletId: string) =>
  p.db
    .select()
    .from(suggestions)
    .where(and(eq(suggestions.source_bullet_id, bulletId), eq(suggestions.state, 'active')))
    .all()

const questionsOf = (p: Phone, bulletId: string) =>
  p.db
    .select()
    .from(questions)
    .where(and(eq(questions.source_bullet_id, bulletId), eq(questions.state, 'active')))
    .all()

const suggestion = (p: Phone, id: string) =>
  p.db.select().from(suggestions).where(eq(suggestions.id, id)).get()

/** Capture typed text on the phone, sync, and wait until the server is done with it. */
async function captureAndProcess(p: Phone, name: string, text: string, links = {}) {
  const id = captureBullet(p.db, { text, ...links }, p.deps)
  const t0 = Date.now()
  const watch = await syncUntil(p, id, isSettled, CAPTURE_TIMEOUT)
  const b = p.db.select().from(bullets).where(eq(bullets.id, id)).get()
  const ths = listThoughts(p.db, id)
  const sgs = suggestionsOf(p, id)
  record({
    type: 'latency',
    name,
    kind: 'typed',
    chars: text.length,
    thoughts: ths.length,
    actionable: ths.filter((t) =>
      ['task', 'event', 'tracker', 'activity', 'to_check'].includes(t.kind),
    ).length,
    ms: Date.now() - t0,
    transitions: watch.seen,
    status: b?.server_status,
  })
  record({
    type: 'extraction',
    name,
    text,
    thoughts: ths.map((t) => ({ kind: t.kind, text: t.text, span: [t.span_start, t.span_end] })),
    suggestions: sgs.map((s) => ({
      kind: s.target_kind,
      op: s.operation,
      tier: s.tier,
      status: s.status,
      payload: s.payload,
      thought: ths.find((t) => t.id === s.source_thought_id)?.position ?? null,
    })),
    questions: questionsOf(p, id).map((q) => ({
      topic: q.topic,
      text: q.text,
      options: q.options,
    })),
  })
  return { id, watch, bullet: b, thoughts: ths, suggestions: sgs }
}

/** A reading that waits on a proposed tracker (decided with "Start tracking …?", never alone). */
const isDependentReading = (s: { target_kind: string; operation: string }) =>
  s.target_kind === 'tracker_entry' && s.operation === 'create'

/** Contract checks every processed capture must pass. */
function expectProcessedContract(p: Phone, r: Awaited<ReturnType<typeof captureAndProcess>>) {
  expect(r.bullet?.server_status).toMatch(/^(processed|needs_review)$/)
  expect(r.thoughts.length).toBeGreaterThan(0)
  for (const s of r.suggestions) {
    expect(['auto', 'suggest', 'ask']).toContain(s.tier)
    // Definitions are never auto-applied.
    if (s.target_kind === 'tracker') expect(s.tier).not.toBe('auto')
    if (s.tier === 'auto') expect(s.status).toBe('accepted')
    // Decision 3: only a value-less record may auto-apply.
    if (s.tier === 'auto' && s.target_kind === 'activity') {
      expect((s.payload as { quantity?: number | null }).quantity ?? null).toBeNull()
    }
    // A reading of a proposed tracker points at that tracker suggestion, and waits for it.
    if (isDependentReading(s)) {
      const t = r.suggestions.find((x) => x.id === s.payload.tracker_id)
      expect(t?.target_kind).toBe('tracker')
      expect(s.tier).not.toBe('auto')
    }
  }
  // Decision 6: the phone's quiet line for its latest capture, once the server is done.
  const latest = captureCounts(p.db).latest
  if (latest?.id === r.id) {
    const notice = captureNotice({
      saved: false,
      failedCount: 0,
      onPhoneCount: 0,
      cannotReachServer: false,
      latest,
      now: Date.now(),
    })
    expect(notice.kind).toBe(latest.things > 0 ? 'found' : 'none')
    record({ type: 'feedback', name: r.id, notice, things: latest.things })
  }
  const pending = r.suggestions.some((s) => s.status === 'pending')
  expect(r.bullet?.server_status).toBe(pending ? 'needs_review' : 'processed')
  // The phone's outbox is empty once the server has everything.
  expect(p.client.pendingCount()).toBe(0)
}

const SPLIT = (s: string) => s.toLowerCase()
/** What a suggested thing is called (its title or name). */
const label = (payload: unknown) => {
  const p = payload as { title?: string | null; name?: string | null }
  return p.title ?? p.name ?? ''
}

describe.skipIf(!enabled)('slice 1 end to end (real home server)', () => {
  const p = createPhone()
  let ramble: Awaited<ReturnType<typeof captureAndProcess>>
  let reviewCapture: Awaited<ReturnType<typeof captureAndProcess>>

  beforeAll(async () => {
    record({ type: 'run', url: E2E.url, timezone: E2E.timezone })
    await p.sync()
  })

  afterAll(() => p.client.dispose())

  test(
    'a typed ramble: push → processing → thoughts with kinds → suggestions with tiers → pull',
    async () => {
      const text =
        "I'm a bit worried the landlord won't renew the lease. " +
        'Need to check whether the car insurance covers windscreen damage. ' +
        'Why do I keep putting off calling the bank? ' +
        'Dentist Thursday at 3pm. ' +
        'Slept 6 hours. ' +
        'Ran 5k this morning.'
      ramble = await captureAndProcess(p, 'ramble', text)
      expectProcessedContract(p, ramble)
      // The phone saw the server pick it up: synced/processing before the end state.
      expect(ramble.watch.seen.some((s) => s.status === 'processing')).toBe(true)

      const kinds = ramble.thoughts.map((t) => t.kind)
      const kindOf = (needle: string) =>
        ramble.thoughts.find((t) => SPLIT(t.text).includes(needle))?.kind
      quality('ramble: split into >= 5 thoughts', ramble.thoughts.length >= 5, kinds)
      quality('ramble: landlord is a worry', kindOf('landlord') === 'worry', kindOf('landlord'))
      quality(
        'ramble: insurance is to_check',
        kindOf('insurance') === 'to_check',
        kindOf('insurance'),
      )
      quality('ramble: bank is a question', kindOf('bank') === 'question', kindOf('bank'))
      quality('ramble: dentist is an event', kindOf('dentist') === 'event', kindOf('dentist'))
      quality(
        'ramble: slept is a tracker reading',
        kindOf('slept') === 'tracker' || kindOf('slept') === 'activity',
        kindOf('slept'),
      )
      quality('ramble: ran 5k is an activity', kindOf('5k') === 'activity', kindOf('5k'))

      const dentist = ramble.suggestions.find(
        (s) => s.target_kind === 'event' && SPLIT(label(s.payload)).includes('dentist'),
      )
      const at = dentist ? Number((dentist.payload as { starts_at?: number }).starts_at) : NaN
      const z = Number.isFinite(at) ? zoned(at) : null
      quality(
        'ramble: dentist → event on Thursday 15:00 local',
        z?.weekday === 'Thursday' && z.hour === 15 && z.minute === 0,
        { payload: dentist?.payload, local: z },
      )
      quality(
        'ramble: the dentist title is just "Dentist" (decision 5)',
        dentist?.payload.title === 'Dentist',
        dentist?.payload.title,
      )
      // Decision 3 + 4: readings keep their value under a short-named tracker.
      const reading = (tracker: string, value: number) => {
        const offer = ramble.suggestions.find(
          (s) => s.target_kind === 'tracker' && s.payload.name === tracker,
        )
        const entry = ramble.suggestions.find(
          (s) =>
            s.target_kind === 'tracker_entry' &&
            s.payload.value === value &&
            (offer ? s.payload.tracker_id === offer.id : true),
        )
        return { offer, entry }
      }
      const sleep = reading('Sleep', 6)
      quality(
        'ramble: "Slept 6 hours." → Start tracking Sleep? + 6 h (decisions 3, 4)',
        Boolean(sleep.offer && sleep.entry),
        { offer: sleep.offer?.payload, entry: sleep.entry?.payload },
      )
      const run = reading('Run', 5)
      quality(
        'ramble: "Ran 5k this morning." → Start tracking Run? + 5 km',
        Boolean(run.offer && run.entry),
        { offer: run.offer?.payload, entry: run.entry?.payload },
      )
      const autoWithNumber = ramble.suggestions.filter(
        (s) => s.target_kind === 'activity' && s.tier === 'auto' && /\d/.test(label(s.payload)),
      )
      quality(
        'ramble: no reading became a value-less auto activity',
        autoWithNumber.length === 0,
        autoWithNumber.map((s) => s.payload),
      )
      const insurance = ramble.suggestions.find((s) =>
        SPLIT(label(s.payload)).includes('insurance'),
      )
      if (insurance) {
        quality(
          'ramble: the insurance title has no trailing period (decision 5)',
          !/[.!?]$/.test(label(insurance.payload)),
          label(insurance.payload),
        )
      }
    },
    CAPTURE_TIMEOUT,
  )

  test(
    'mixed Arabizi / French / English keeps its own words, and "jeudi 15h" resolves',
    async () => {
      const text =
        'khalast el meeting ma3 Rami, bukra lazem eb3at el report la Nadine. ' +
        'RDV chez le coiffeur jeudi 15h. ' +
        'ana ktir t3ban today, mood 2 sur 5.'
      const r = await captureAndProcess(p, 'mixed', text)
      expectProcessedContract(p, r)
      // Thoughts are the user's words, not a translation: each thought's span points into the text.
      for (const t of r.thoughts) {
        if (t.span_start !== null && t.span_end !== null) {
          expect(text.slice(t.span_start, t.span_end).length).toBeGreaterThan(0)
        }
      }
      const words = ['bukra', 'coiffeur', 't3ban']
      for (const w of words) {
        quality(
          `mixed: "${w}" kept verbatim in a thought`,
          r.thoughts.some((t) => SPLIT(t.text).includes(w)),
          r.thoughts.map((t) => t.text),
        )
      }
      const coiffeur = r.suggestions.find(
        (s) =>
          (s.target_kind === 'event' || s.target_kind === 'task') &&
          SPLIT(label(s.payload)).includes('coiffeur'),
      )
      const at = coiffeur
        ? Number(
            (coiffeur.payload as { starts_at?: number; due_at?: number }).starts_at ??
              (coiffeur.payload as { due_at?: number }).due_at,
          )
        : NaN
      const z = Number.isFinite(at) ? zoned(at) : null
      quality(
        'mixed: "jeudi 15h" → Thursday 15:00 local',
        z?.weekday === 'Thursday' && z.hour === 15,
        { payload: coiffeur?.payload, local: z },
      )
      const report = r.suggestions.find((s) => SPLIT(label(s.payload)).includes('report'))
      quality(
        'mixed: "bukra lazem eb3at el report" → a task due tomorrow',
        Boolean(report),
        report?.payload,
      )
      quality(
        'mixed: the report title keeps the Arabizi words without "bukra" (decision 5)',
        Boolean(report) && !SPLIT(label(report?.payload)).includes('bukra'),
        label(report?.payload),
      )
      quality(
        'mixed: the coiffeur title has no "jeudi 15h" (decision 5)',
        Boolean(coiffeur) && !/jeudi|15h/i.test(label(coiffeur?.payload)),
        label(coiffeur?.payload),
      )
      const mood = r.suggestions.find((s) => s.target_kind === 'tracker')
      const moodEntry = r.suggestions.find(
        (s) => s.target_kind === 'tracker_entry' && s.payload.value === 2,
      )
      quality(
        'mixed: "mood 2 sur 5" → Start tracking Mood? (scale 1–5) + 2 (decisions 3, 4)',
        mood?.payload.name === 'Mood' && Boolean(moodEntry),
        { offer: mood?.payload, entry: moodEntry?.payload },
      )
    },
    CAPTURE_TIMEOUT,
  )

  test(
    'inbox: held decision + undo window, accept, reject, edit-accept, undo, answer, dismiss',
    async () => {
      const today = zoned(Date.now()).weekday
      const text =
        'Call the plumber about the kitchen leak tomorrow. ' +
        'Buy a birthday present for Maya before Saturday. ' +
        'Pay the electricity bill. ' +
        `Gym session ${today} at 7pm. ` +
        'Meditated 20 minutes. ' +
        'Drank 3 glasses of water.'
      reviewCapture = await captureAndProcess(p, 'review', text)
      expectProcessedContract(p, reviewCapture)
      const pending = () =>
        suggestionsOf(p, reviewCapture.id).filter(
          (s) => s.status === 'pending' && s.target_kind !== 'tracker' && !isDependentReading(s),
        )
      const all = reviewCapture.suggestions
      const titled = (t: string) => all.find((s) => label(s.payload) === t)
      quality(
        'review: "Pay the electricity bill." → title "Pay the electricity bill" (decision 5)',
        Boolean(titled('Pay the electricity bill')),
        all.map((s) => label(s.payload)),
      )
      const invented = all.filter(
        (s) => s.target_kind === 'activity' && /\bpaid\b/i.test(label(s.payload)),
      )
      quality(
        'review: no invented "Paid the electricity bill" activity',
        invented.length === 0,
        invented.map((s) => s.payload),
      )
      for (const [tracker, value] of [
        ['Meditation', 20],
        ['Water', 3],
      ] as const) {
        const offer = all.find((s) => s.target_kind === 'tracker' && s.payload.name === tracker)
        const entry = all.find(
          (s) => s.target_kind === 'tracker_entry' && s.payload.value === value,
        )
        quality(
          `review: a ${tracker} reading keeps ${value} (decisions 3, 4)`,
          Boolean(offer && entry),
          { offer: offer?.payload, entry: entry?.payload },
        )
      }
      const qs = questionsOf(p, reviewCapture.id)
      quality(
        `review: "${today} at 7pm" on a ${today} asks "Which ${today}?"`,
        qs.some((q) => q.topic === 'date'),
        qs.map((q) => q.text),
      )
      quality(
        'review: a reading with no tracker offers "Start tracking …?"',
        qs.some((q) => q.topic === 'new_tracker'),
        qs.map((q) => q.text),
      )
      const questionTargets = new Set(qs.map((q) => q.suggestion_id))
      const free = pending().filter((s) => !questionTargets.has(s.id))
      expect(free.length).toBeGreaterThanOrEqual(3)
      const [a, b, c] = free as [(typeof free)[0], (typeof free)[0], (typeof free)[0]]

      // Held decision: an accept inside its Undo window never leaves the phone…
      expect(decideHeld(p.db, a.id, 'accepted', Date.now() + 60_000, p.deps)).toBe(true)
      await p.sync()
      expect(p.client.pendingCount()).toBe(1)
      // …so Undo just retracts it locally.
      expect(retractDecision(p.db, a.id, a.payload, Date.now())).toBe(true)
      expect(suggestion(p, a.id)?.status).toBe('pending')
      expect(p.client.pendingCount()).toBe(0)
      // Decide again; once the window closes the accept goes out and the server applies it.
      expect(decideHeld(p.db, a.id, 'accepted', Date.now() + 60_000, p.deps)).toBe(true)
      releaseHolds(p.db, [a.id])
      await p.sync()
      const accepted = suggestion(p, a.id)
      expect(accepted?.status).toBe('accepted')
      expect(accepted?.applied_entity_id).toBeTruthy()

      // Reject.
      rejectSuggestion(p.db, b.id, p.deps)
      await p.sync()
      expect(suggestion(p, b.id)?.status).toBe('rejected')
      expect(suggestion(p, b.id)?.applied_entity_id).toBeNull()

      // Edit-accept: the user's payload is what gets applied.
      const edited = { ...c.payload } as Record<string, unknown>
      if (c.target_kind === 'task' || c.target_kind === 'event')
        edited.title = 'Edited by the e2e run'
      else if (c.target_kind === 'activity') edited.notes = 'edited by the e2e run'
      acceptSuggestion(p.db, c.id, p.deps, edited as typeof c.payload)
      await p.sync()
      const ce = suggestion(p, c.id)
      expect(ce?.status).toBe('edited')
      expect(ce?.applied_entity_id).toBeTruthy()
      if (c.target_kind === 'task') {
        const t = p.db
          .select()
          .from(tasks)
          .where(eq(tasks.id, String(ce?.applied_entity_id)))
          .get()
        expect(t?.title).toBe('Edited by the e2e run')
      }

      // Undo an applied suggestion: what it created is removed (soft), it reads as rejected.
      undoSuggestion(p.db, a.id, p.deps)
      await p.sync()
      const undone = suggestion(p, a.id)
      expect(undone?.status).toBe('rejected')
      expect(undone?.applied_entity_id).toBeNull()

      // Answer a question by tapping an option, and dismiss another.
      const date = qs.find((q) => q.topic === 'date' && q.options.length > 0)
      const tracker = qs.find((q) => q.topic === 'new_tracker')
      if (date) {
        answerQuestion(p.db, date.id, date.options[1] ?? date.options[0]!, p.deps)
        await p.sync()
        const q = p.db.select().from(questions).where(eq(questions.id, date.id)).get()
        expect(q?.status).toBe('answered')
        expect(q?.answer_option).toBe(date.options[1] ?? date.options[0])
        const s = date.suggestion_id ? suggestion(p, date.suggestion_id) : undefined
        expect(s?.status).toMatch(/^(accepted|edited)$/)
        const ev = s?.applied_entity_id
          ? p.db.select().from(events).where(eq(events.id, s.applied_entity_id)).get()
          : undefined
        const tk = s?.applied_entity_id
          ? p.db.select().from(tasks).where(eq(tasks.id, s.applied_entity_id)).get()
          : undefined
        const when = ev?.starts_at ?? tk?.due_at
        record({
          type: 'note',
          name: 'date answer applied',
          option: q?.answer_option,
          local: when ? zoned(when) : null,
        })
      }
      if (tracker) {
        // "Yes" creates the tracker (used by the journal test for a reading to edit) and logs
        // the reading that waited on it.
        const waiting = suggestionsOf(p, reviewCapture.id).filter(
          (s) => isDependentReading(s) && s.payload.tracker_id === tracker.suggestion_id,
        )
        answerQuestion(p.db, tracker.id, 'Yes', p.deps)
        await p.sync()
        const q = p.db.select().from(questions).where(eq(questions.id, tracker.id)).get()
        expect(q?.status).toBe('answered')
        const s = tracker.suggestion_id ? suggestion(p, tracker.suggestion_id) : undefined
        expect(s?.status).toBe('accepted')
        expect(s?.applied_entity_id).toBeTruthy()
        for (const w of waiting) {
          const logged = suggestion(p, w.id)
          expect(logged?.status).toBe('accepted')
          const e = p.db
            .select()
            .from(trackerEntries)
            .where(eq(trackerEntries.id, String(logged?.applied_entity_id)))
            .get()
          expect(e?.tracker_id).toBe(s?.applied_entity_id)
        }
        record({ type: 'note', name: 'Yes logged readings', count: waiting.length })
      }
      const other = questionsOf(p, reviewCapture.id).find((q) => q.status === 'open')
      if (other) {
        dismissQuestion(p.db, other.id, p.deps)
        await p.sync()
        expect(p.db.select().from(questions).where(eq(questions.id, other.id)).get()?.status).toBe(
          'dismissed',
        )
      }
      record({
        type: 'note',
        name: 'inbox questions exercised',
        date: Boolean(date),
        new_tracker: Boolean(tracker),
        dismissed: Boolean(other),
      })
      expect(p.client.pendingCount()).toBe(0)
    },
    CAPTURE_TIMEOUT,
  )

  test(
    'journal: resolve / unresolve, loop note, task / event / reading edits',
    async () => {
      // Open loops from the ramble (to_check / question).
      const loops = ramble.thoughts.filter((t) => t.kind === 'to_check' || t.kind === 'question')
      quality(
        'journal: the ramble has open loops',
        loops.length >= 1,
        ramble.thoughts.map((t) => t.kind),
      )
      let loop = loops[0]
      if (!loop) {
        // The model missed them: make one by hand, as the user would.
        const t =
          ramble.thoughts.find((x) => SPLIT(x.text).includes('insurance')) ?? ramble.thoughts[0]!
        reclassifyThought(p.db, t.id, 'to_check', p.deps)
        await p.sync()
        loop = p.db.select().from(thoughts).where(eq(thoughts.id, t.id)).get()!
      }
      resolveThought(p.db, loop.id, p.deps)
      await p.sync()
      expect(
        p.db.select().from(thoughts).where(eq(thoughts.id, loop.id)).get()?.resolved_at,
      ).toBeTruthy()
      unresolveThought(p.db, loop.id, p.deps)
      await p.sync()
      expect(
        p.db.select().from(thoughts).where(eq(thoughts.id, loop.id)).get()?.resolved_at,
      ).toBeNull()

      // Close it "with a note": an ordinary capture pointing at the thought.
      const note = await captureAndProcess(
        p,
        'loop note',
        'Checked with the insurer: windscreen damage is covered, 100 euro excess.',
        { resolvesThoughtId: loop.id },
      )
      const closed = p.db.select().from(thoughts).where(eq(thoughts.id, loop.id)).get()
      expect(closed?.resolved_at).toBeTruthy()
      expect(closed?.resolved_by_bullet_id).toBe(note.id)
      expect(note.bullet?.resolves_thought_id).toBe(loop.id)

      // A task to complete / reopen / reschedule: accept one if none is applied yet.
      let task: typeof tasks.$inferSelect | undefined = p.db
        .select()
        .from(tasks)
        .where(eq(tasks.state, 'active'))
        .all()[0]
      if (!task) {
        const s = suggestionsOf(p, reviewCapture.id).find(
          (x) => x.target_kind === 'task' && x.status === 'pending',
        )
        expect(s).toBeTruthy()
        acceptSuggestion(p.db, s!.id, p.deps)
        await p.sync()
        task = p.db
          .select()
          .from(tasks)
          .where(eq(tasks.id, String(suggestion(p, s!.id)?.applied_entity_id)))
          .get()
      }
      expect(task).toBeTruthy()
      updateTask(p.db, task!.id, { status: 'done' }, p.deps)
      await p.sync()
      expect(p.db.select().from(tasks).where(eq(tasks.id, task!.id)).get()?.status).toBe('done')
      updateTask(p.db, task!.id, { status: 'todo' }, p.deps)
      const due = Date.now() + 3 * 86_400_000
      updateTask(p.db, task!.id, { due_at: due }, p.deps)
      await p.sync()
      const t2 = p.db.select().from(tasks).where(eq(tasks.id, task!.id)).get()
      expect(t2?.status).toBe('todo')
      expect(t2?.due_at).toBe(due)
      expect(t2?.user_edited_at).toBeTruthy()

      // An event: accept the dentist if needed, then move it.
      let ev: typeof events.$inferSelect | undefined = p.db
        .select()
        .from(events)
        .where(eq(events.state, 'active'))
        .all()[0]
      if (!ev) {
        const s = suggestionsOf(p, ramble.id).find(
          (x) => x.target_kind === 'event' && x.status === 'pending',
        )
        if (s) {
          acceptSuggestion(p.db, s.id, p.deps)
          await p.sync()
          ev = p.db
            .select()
            .from(events)
            .where(eq(events.id, String(suggestion(p, s.id)?.applied_entity_id)))
            .get()
        }
      }
      if (quality('journal: an event exists to edit', Boolean(ev), null) && ev) {
        const starts = ev.starts_at + 3_600_000
        updateEvent(p.db, ev.id, { starts_at: starts, ends_at: starts + 3_600_000 }, p.deps)
        await p.sync()
        const e2 = p.db.select().from(events).where(eq(events.id, ev.id)).get()
        expect(e2?.starts_at).toBe(starts)
        expect(e2?.user_edited_at).toBeTruthy()
        // An end before the start is refused locally (and would be `invalid` on the server).
        expect(() => updateEvent(p.db, ev!.id, { ends_at: starts - 1 }, p.deps)).toThrow()
      }

      // A tracker reading: log one against an existing tracker, accept, then correct it. No
      // tracker yet: say Yes to any "Start tracking …?" another capture raised.
      const offer = listOpenQuestions(p.db).find((q) => q.topic === 'new_tracker')
      if (
        p.db.select().from(trackers).where(eq(trackers.state, 'active')).all().length === 0 &&
        offer
      ) {
        answerQuestion(p.db, offer.id, 'Yes', p.deps)
        await p.sync()
        record({ type: 'note', name: 'answered Yes to a tracker offer', question: offer.text })
      }
      const tr = p.db.select().from(trackers).where(eq(trackers.state, 'active')).all()
      record({
        type: 'note',
        name: 'trackers on server',
        trackers: tr.map((t) => [t.name, t.config]),
      })
      if (
        quality('journal: a tracker exists (created via "Start tracking?")', tr.length > 0, null)
      ) {
        const name = tr[0]!.name
        const r = await captureAndProcess(p, 'reading', `${name} 4 today`)
        const entry = r.suggestions.find((s) => s.target_kind === 'tracker_entry')
        quality(
          `journal: "${name} 4 today" appends to the existing tracker`,
          entry?.operation === 'append' && entry.target_id === tr[0]!.id,
          entry ?? r.suggestions,
        )
        if (entry) {
          if (entry.status === 'pending') acceptSuggestion(p.db, entry.id, p.deps)
          await p.sync()
          const id = String(suggestion(p, entry.id)?.applied_entity_id)
          const before = p.db.select().from(trackerEntries).where(eq(trackerEntries.id, id)).get()
          expect(before).toBeTruthy()
          updateTrackerEntry(p.db, id, 5, p.deps)
          await p.sync()
          const after = p.db.select().from(trackerEntries).where(eq(trackerEntries.id, id)).get()
          expect(after?.value).toBe(5)
          expect(after?.user_edited_at).toBeTruthy()
        }
      }
      expect(p.client.pendingCount()).toBe(0)
    },
    3 * CAPTURE_TIMEOUT,
  )

  test(
    'editing a capture re-processes it without overwriting what the user edited',
    async () => {
      // Make the dentist event the user's own (accept + hand edit), reclassify a thought, then edit.
      const ev = suggestionsOf(p, ramble.id).find((s) => s.target_kind === 'event')
      if (ev && ev.status === 'pending') {
        acceptSuggestion(p.db, ev.id, p.deps)
        await p.sync()
      }
      const evId = ev ? suggestion(p, ev.id)?.applied_entity_id : null
      if (evId) {
        updateEvent(p.db, evId, { title: 'Dentist (Dr. Haddad)' }, p.deps)
      }
      const worry = ramble.thoughts.find((t) => SPLIT(t.text).includes('landlord'))!
      reclassifyThought(p.db, worry.id, 'note', p.deps)
      await p.sync()

      const before = suggestionsOf(p, ramble.id)
      const text =
        "I'm a bit worried the landlord won't renew the lease. " +
        'Need to check whether the car insurance covers windscreen damage. ' +
        'Dentist Thursday at 3pm. ' +
        'Slept 6 hours. ' +
        'Buy running shoes this weekend.'
      editBullet(p.db, ramble.id, text, p.deps)
      const t0 = Date.now()
      // saved_local → synced → processing → done, on the same bullet.
      const watch = await syncUntil(
        p,
        ramble.id,
        (b) => isSettled(b) && b.text === text && p.client.pendingCount() === 0,
        CAPTURE_TIMEOUT,
      )
      record({
        type: 'latency',
        name: 'edit reprocess',
        kind: 'typed',
        ms: Date.now() - t0,
        transitions: watch.seen,
      })
      const after = suggestionsOf(p, ramble.id)
      const ths = listThoughts(p.db, ramble.id)
      record({
        type: 'extraction',
        name: 'edit reprocess',
        text,
        thoughts: ths.map((t) => ({ kind: t.kind, kind_source: t.kind_source, text: t.text })),
        before: before.map((s) => ({
          id: s.id,
          kind: s.target_kind,
          status: s.status,
          payload: s.payload,
        })),
        after: after.map((s) => ({
          id: s.id,
          kind: s.target_kind,
          status: s.status,
          payload: s.payload,
        })),
      })
      // An unchanged thought keeps its kind on re-processing (the model's kind used to drift).
      const insuranceBefore = ramble.thoughts.find((t) => SPLIT(t.text).includes('insurance'))
      const insuranceAfter = ths.find((t) => SPLIT(t.text).includes('insurance'))
      if (insuranceBefore && insuranceAfter && insuranceBefore.text === insuranceAfter.text) {
        quality(
          'edit: the unchanged insurance thought keeps its kind',
          insuranceAfter.kind === insuranceBefore.kind,
          [insuranceBefore.kind, insuranceAfter.kind],
        )
      }
      // The user's kind sticks.
      const w2 = ths.find((t) => SPLIT(t.text).includes('landlord'))
      expect(w2?.kind).toBe('note')
      expect(w2?.kind_source).toBe('user')
      // The hand-edited event is untouched.
      if (evId) {
        const e = p.db.select().from(events).where(eq(events.id, evId)).get()
        expect(e?.state).toBe('active')
        expect(e?.title).toBe('Dentist (Dr. Haddad)')
      }
      // "Ran 5k" is gone from the text: its suggestion is withdrawn (pending → gone; applied → undone).
      const runBefore = before.find(
        (s) =>
          (s.target_kind === 'activity' && /\b(run|ran|5k)\b/.test(SPLIT(label(s.payload)))) ||
          (s.target_kind === 'tracker' && s.payload.name === 'Run'),
      )
      if (runBefore) {
        const now = p.db.select().from(suggestions).where(eq(suggestions.id, runBefore.id)).get()
        quality(
          'edit: the removed "ran 5k" is withdrawn',
          now?.state === 'deleted' || now?.status === 'rejected',
          now,
        )
      }
      quality(
        'edit: the new "running shoes" task is added',
        after.some((s) => SPLIT(label(s.payload)).includes('shoe')),
        after.map((s) => s.payload),
      )
    },
    CAPTURE_TIMEOUT,
  )

  // A tone has no speech: it fails as transcription_no_speech (tested below), so these two need a
  // speech WAV.
  test.skipIf(!E2E.speechWav)(
    'voice: resumable upload → transcribing → server transcript replaces the draft → thoughts',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'bullet-e2e-'))
      const speech = readBytes(E2E.speechWav!)
      const path = join(dir, 'speech.wav')
      writeFileSync(path, speech)
      // Fail the second upload request once: the next sync resumes from the server's offset.
      let uploads = 0
      const flaky = createPhone({
        chunkBytes: 32 * 1024,
        wrap: (t): SyncTransport => ({
          ...t,
          uploadAudio: (id, offset, bytes) => {
            uploads += 1
            if (uploads === 2) return Promise.reject(new TransportError('network', 'dropped'))
            return t.uploadAudio(id, offset, bytes)
          },
        }),
      })
      const durationMs = wavDurationMs(speech)
      const draft = 'remind me to buy all of oil tomorrow' // a plausible on-device mishearing
      const id = captureVoiceBullet(
        flaky.db,
        {
          text: draft,
          textEditedByUser: false,
          audio: {
            localPath: path,
            mimeType: 'audio/wav',
            durationMs,
            sizeBytes: speech.length,
            sha256: sha256(speech),
          },
          draft: {
            text: draft,
            engine: 'apple-sfspeechrecognizer',
            model: null,
            languages: ['en-US'],
          },
        },
        flaky.deps,
      )
      const t0 = Date.now()
      const first = await flaky.client.sync()
      expect(first?.ok).toBe(false) // the dropped chunk
      const watch = await syncUntil(flaky, id, isSettled, CAPTURE_TIMEOUT)
      const ms = Date.now() - t0
      const att = flaky.db
        .select()
        .from(audioAttachments)
        .where(eq(audioAttachments.bullet_id, id))
        .get()
      expect(att?.upload_status).toBe('uploaded')
      expect(att?.received_bytes).toBe(speech.length)
      expect(uploads).toBeGreaterThan(2)
      const trs = flaky.db.select().from(transcripts).where(eq(transcripts.bullet_id, id)).all()
      const server = trs.find((t) => t.kind === 'server')
      expect(trs.some((t) => t.kind === 'device_draft')).toBe(true)
      expect(server).toBeTruthy()
      const b = flaky.db.select().from(bullets).where(eq(bullets.id, id)).get()
      // Not edited by the user → the server transcript is the text now.
      expect(b?.text).toBe(server?.text)
      const transcribing = watch.seen.find((s) => s.status === 'transcribing')
      const processing = watch.seen.find((s) => s.status === 'processing')
      record({
        type: 'latency',
        name: 'voice',
        kind: 'voice',
        audio_ms: durationMs,
        ms,
        transcribe_ms: transcribing && processing ? processing.ms - transcribing.ms : null,
        transitions: watch.seen,
        transcript: server?.text,
        languages: server?.languages,
      })
      quality('voice: the phone saw `transcribing`', Boolean(transcribing), watch.seen)
      for (const w of E2E.speechWords) {
        quality(`voice: transcript has "${w}"`, SPLIT(server?.text ?? '').includes(w), server?.text)
      }
      const ths = listThoughts(flaky.db, id)
      const things = suggestionsOf(flaky, id)
      if (SPLIT(server?.text ?? '').includes('remind me')) {
        quality(
          'voice: "Remind me to buy olive oil tomorrow" → a task, not a tracker',
          things.some((s) => s.target_kind === 'task') &&
            !things.some((s) => s.target_kind === 'tracker'),
          things.map((s) => [s.target_kind, s.payload]),
        )
        const task = things.find((s) => s.target_kind === 'task')
        quality(
          'voice: its title is the user\'s words without "remind me" or "tomorrow"',
          Boolean(task) && !/remind|tomorrow/i.test(label(task?.payload)),
          label(task?.payload),
        )
      }
      record({
        type: 'extraction',
        name: 'voice',
        text: b?.text,
        thoughts: ths.map((t) => ({ kind: t.kind, text: t.text })),
        suggestions: suggestionsOf(flaky, id).map((s) => ({
          kind: s.target_kind,
          tier: s.tier,
          payload: s.payload,
        })),
      })
      flaky.client.dispose()
    },
    CAPTURE_TIMEOUT,
  )

  test.skipIf(!E2E.speechWav)(
    'voice: a draft the user edited wins over the server transcript',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'bullet-e2e-'))
      const speech = readBytes(E2E.speechWav!)
      const path = join(dir, 'speech.wav')
      writeFileSync(path, speech)
      const mine = 'Buy olive oil and lemons tomorrow.'
      const id = captureVoiceBullet(
        p.db,
        {
          text: mine,
          textEditedByUser: true,
          audio: {
            localPath: path,
            mimeType: 'audio/wav',
            durationMs: wavDurationMs(speech),
            sizeBytes: speech.length,
            sha256: sha256(speech),
          },
          draft: {
            text: 'buy all of oil tomorrow',
            engine: 'apple-sfspeechrecognizer',
            model: null,
            languages: ['en-US'],
          },
        },
        p.deps,
      )
      await syncUntil(p, id, isSettled, CAPTURE_TIMEOUT)
      const b = p.db.select().from(bullets).where(eq(bullets.id, id)).get()
      expect(b?.text).toBe(mine)
      expect(b?.text_edited_by_user).toBe(true)
      const server = p.db
        .select()
        .from(transcripts)
        .where(and(eq(transcripts.bullet_id, id), eq(transcripts.kind, 'server')))
        .get()
      expect(server).toBeTruthy()
      expect(listThoughts(p.db, id).length).toBeGreaterThan(0)
    },
    CAPTURE_TIMEOUT,
  )

  test(
    'tracker readings: Yes to "Start tracking?", a later reading appends, the value is corrected',
    async () => {
      // A name no earlier run used, so this test stands alone on a shared database.
      const name = `energy${crypto.randomUUID().slice(0, 4).replace(/\d/g, 'x')}`
      const first = await captureAndProcess(p, 'tracker offer', `${name} level 3 out of 5 today`)
      const offer = questionsOf(p, first.id).find((q) => q.topic === 'new_tracker')
      if (
        !quality('tracker: a reading offers "Start tracking …?"', Boolean(offer), first.suggestions)
      )
        return
      const proposed = suggestion(p, offer!.suggestion_id!)
      quality(
        'tracker: the offer names a short noun, not the reading (decision 4)',
        typeof proposed?.payload.name === 'string' &&
          !/\d|level|today/i.test(String(proposed.payload.name)) &&
          offer!.text === `Start tracking ${String(proposed.payload.name)}?`,
        { name: proposed?.payload.name, question: offer!.text },
      )
      const reading = first.suggestions.find(
        (x) => isDependentReading(x) && x.payload.tracker_id === offer!.suggestion_id,
      )
      quality('tracker: the reading (3) waits on the offer', reading?.payload.value === 3, reading)
      answerQuestion(p.db, offer!.id, 'Yes', p.deps)
      await p.sync()
      const s = suggestion(p, offer!.suggestion_id!)
      expect(s?.status).toBe('accepted')
      const tracker = p.db
        .select()
        .from(trackers)
        .where(eq(trackers.id, String(s?.applied_entity_id)))
        .get()
      expect(tracker).toBeTruthy()
      if (reading) {
        // Yes logged the first reading under the new tracker.
        const logged = suggestion(p, reading.id)
        expect(logged?.status).toBe('accepted')
        expect(
          p.db
            .select()
            .from(trackerEntries)
            .where(eq(trackerEntries.id, String(logged?.applied_entity_id)))
            .get()?.value,
        ).toBe(3)
      }
      record({ type: 'note', name: 'tracker created', tracker: tracker?.name, offer: offer!.text })

      const second = await captureAndProcess(p, 'tracker reading', `${tracker!.name} 4 today`)
      const entry = second.suggestions.find((x) => x.target_kind === 'tracker_entry')
      if (
        !quality(
          'tracker: the next reading appends to it',
          entry?.operation === 'append' && entry.target_id === tracker!.id,
          second.suggestions,
        )
      )
        return
      if (entry!.status === 'pending') acceptSuggestion(p.db, entry!.id, p.deps)
      await p.sync()
      const id = String(suggestion(p, entry!.id)?.applied_entity_id)
      expect(p.db.select().from(trackerEntries).where(eq(trackerEntries.id, id)).get()).toBeTruthy()
      updateTrackerEntry(p.db, id, 5, p.deps)
      await p.sync()
      const after = p.db.select().from(trackerEntries).where(eq(trackerEntries.id, id)).get()
      expect(after?.value).toBe(5)
      expect(after?.user_edited_at).toBeTruthy()
      record({ type: 'note', name: 'tracker_entry.update applied', value: after?.value })
    },
    2 * CAPTURE_TIMEOUT,
  )

  test(
    'idempotency: resent ops and a lost push response create no duplicates',
    async () => {
      // A push whose response is lost: the server applied it, the phone resends.
      let drop = true
      const lossy = createPhone({
        wrap: (t): SyncTransport => ({
          ...t,
          push: async (req) => {
            const res = await t.push(req)
            if (drop) {
              drop = false
              throw new TransportError('network', 'connection reset after the server answered')
            }
            return res
          },
        }),
      })
      // Unique per run: the server database may hold earlier runs.
      const text = `Water the plants on Sunday (${crypto.randomUUID().slice(0, 8)}).`
      const id = captureBullet(lossy.db, { text }, lossy.deps)
      const op = lossy.db.select().from(outbox).get()!.op as PushOp
      expect((await lossy.client.sync())?.ok).toBe(false)
      expect(lossy.client.pendingCount()).toBe(1)
      await lossy.sync()
      expect(lossy.client.pendingCount()).toBe(0)
      // Resend the very same op by hand, twice in one request.
      const again = await lossy.transport.push({ ops: [op, op] })
      expect(again.results.map((r) => r.status)).toEqual(['duplicate', 'duplicate'])
      await syncUntil(lossy, id, isSettled, CAPTURE_TIMEOUT)
      // A fresh phone pulling everything sees exactly one such bullet.
      const fresh = createPhone()
      await fresh.sync()
      const same = fresh.db.select().from(bullets).where(eq(bullets.text, text)).all()
      expect(same).toHaveLength(1)
      // Resending decision ops is harmless too.
      const s = suggestionsOf(fresh, id).find((x) => x.status === 'pending')
      if (s) {
        const accept: PushOp = {
          op_id: crypto.randomUUID(),
          type: 'suggestion.accept',
          suggestion_id: s.id,
        }
        const r1 = await fresh.transport.push({ ops: [accept] })
        const r2 = await fresh.transport.push({ ops: [accept] })
        expect(r1.results[0]?.status).toBe('applied')
        expect(r2.results[0]?.status).toBe('duplicate')
        await fresh.sync()
        const created = fresh.db
          .select()
          .from(tasks)
          .where(eq(tasks.source_bullet_id, id))
          .all()
          .concat(
            fresh.db.select().from(events).where(eq(events.source_bullet_id, id)).all() as never[],
          )
        expect(created.filter((x) => x.state === 'active')).toHaveLength(1)
      }
      // The full pull is consistent: no entity appears twice.
      for (const table of [tasks, events, activities, trackerEntries, trackers, thoughts]) {
        const ids = fresh.db
          .select({ id: table.id })
          .from(table)
          .all()
          .map((r) => r.id)
        expect(new Set(ids).size).toBe(ids.length)
      }
      lossy.client.dispose()
      fresh.client.dispose()
    },
    CAPTURE_TIMEOUT,
  )

  test.skipIf(!E2E.llmStop || !E2E.llmStart)(
    'llama-server stops mid-run: captures stay safe, retry with backoff, recover on restart',
    async () => {
      const text = 'Book the car service for next Tuesday morning. Read 30 pages of my book.'
      const id = captureBullet(p.db, { text }, p.deps)
      // Wait until the server is reading it, then pull the plug.
      await syncUntil(
        p,
        id,
        (b) => b.server_status === 'processing' || isSettled(b),
        CAPTURE_TIMEOUT,
        250,
      )
      const t0 = Date.now()
      runShell(E2E.llmStop!)
      // A second capture arrives while the model is down.
      const id2 = captureBullet(p.db, { text: 'Pick up the dry cleaning on Friday.' }, p.deps)
      const retrying = await syncUntil(
        p,
        id,
        (b) => b.server_status === 'synced' && b.server_error_code !== null,
        5 * MIN,
      )
      const b = p.db.select().from(bullets).where(eq(bullets.id, id)).get()!
      record({
        type: 'outage',
        error: b.server_error_code,
        message: b.server_error_message,
        attempts: b.server_attempts,
        next_retry_in_ms: b.server_next_retry_at ? b.server_next_retry_at - Date.now() : null,
        transitions: retrying.seen,
      })
      expect(b.server_error_code).toMatch(/^llm_(unavailable|timeout)$/)
      expect(b.server_next_retry_at).toBeGreaterThan(Date.now() - 1_000)
      expect(b.text).toBe(text)
      // Nothing lost on the phone: both captures are there, the outbox is drained.
      expect(p.client.pendingCount()).toBe(0)
      expect(p.db.select().from(bullets).where(eq(bullets.id, id2)).get()?.text).toBe(
        'Pick up the dry cleaning on Friday.',
      )
      runShell(E2E.llmStart!)
      await waitForHttp(
        new URL('/health', process.env.BULLET_E2E_LLM_URL ?? 'http://127.0.0.1:8080').toString(),
        5 * MIN,
      )
      const recovered = await syncUntil(
        p,
        id,
        (x) => x.server_status === 'processed' || x.server_status === 'needs_review',
        2 * CAPTURE_TIMEOUT,
        2_000,
      )
      await syncUntil(p, id2, isSettled, CAPTURE_TIMEOUT, 2_000)
      const done = p.db.select().from(bullets).where(eq(bullets.id, id)).get()!
      record({
        type: 'outage_recovery',
        ms_since_outage: Date.now() - t0,
        attempts: done.server_attempts,
        transitions: recovered.seen,
        second: p.db.select().from(bullets).where(eq(bullets.id, id2)).get()?.server_status,
      })
      expect(done.server_error_code).toBeNull()
      expect(done.server_attempts).toBeGreaterThanOrEqual(2)
    },
    3 * CAPTURE_TIMEOUT,
  )

  test(
    'a recording with no speech (and no usable draft) fails at once as transcription_no_speech',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'bullet-e2e-'))
      const tone = toneWav(3)
      const path = join(dir, 'tone.wav')
      writeFileSync(path, tone)
      // Three words: too little to stand in for a transcript (decision 2), so it fails.
      const draft = 'garden note maybe'
      const id = captureVoiceBullet(
        p.db,
        {
          text: draft,
          textEditedByUser: false,
          audio: {
            localPath: path,
            mimeType: 'audio/wav',
            durationMs: wavDurationMs(tone),
            sizeBytes: tone.length,
            sha256: sha256(tone),
          },
          draft: {
            text: draft,
            engine: 'apple-sfspeechrecognizer',
            model: null,
            languages: ['en-US'],
          },
        },
        p.deps,
      )
      const t0 = Date.now()
      const seen = await syncUntil(p, id, isSettled, CAPTURE_TIMEOUT)
      const b = p.db.select().from(bullets).where(eq(bullets.id, id)).get()!
      record({
        type: 'no_speech',
        error: b.server_error_code,
        message: b.server_error_message,
        status: b.server_status,
        attempts: b.server_attempts,
        ms: Date.now() - t0,
        transitions: seen.seen,
        text: b.text,
      })
      // Decision 1: no retries, straight to failed with the no-speech code.
      expect(b.server_status).toBe('failed')
      expect(b.server_error_code).toBe('transcription_no_speech')
      expect(b.server_attempts).toBe(1)
      expect(b.text).toBe(draft)
    },
    CAPTURE_TIMEOUT,
  )

  test(
    'no speech, but a real phone draft: the draft becomes the text and is processed',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'bullet-e2e-'))
      const tone = toneWav(3)
      const path = join(dir, 'tone.wav')
      writeFileSync(path, tone)
      const draft = "Remind me to water the garden tomorrow, it's been dry."
      const id = captureVoiceBullet(
        p.db,
        {
          text: draft,
          textEditedByUser: false,
          audio: {
            localPath: path,
            mimeType: 'audio/wav',
            durationMs: wavDurationMs(tone),
            sizeBytes: tone.length,
            sha256: sha256(tone),
          },
          draft: {
            text: draft,
            engine: 'apple-sfspeechrecognizer',
            model: null,
            languages: ['en-US'],
          },
        },
        p.deps,
      )
      const t0 = Date.now()
      const seen = await syncUntil(p, id, isSettled, CAPTURE_TIMEOUT)
      const b = p.db.select().from(bullets).where(eq(bullets.id, id)).get()!
      const things = p.db
        .select()
        .from(suggestions)
        .where(and(eq(suggestions.source_bullet_id, id), eq(suggestions.state, 'active')))
        .all()
      record({
        type: 'draft_fallback',
        status: b.server_status,
        text_from_draft: b.text_from_draft,
        ms: Date.now() - t0,
        transitions: seen.seen,
        things: things.map((s) => ({ kind: s.target_kind, tier: s.tier, payload: s.payload })),
      })
      expect(b.server_status).toMatch(/^(processed|needs_review)$/)
      expect(b.text_from_draft).toBe(true)
      expect(b.text).toBe(draft)
      expect(b.server_error_code).toBeNull()
      quality(
        'draft fallback: the draft produced a task',
        things.some((s) => s.target_kind === 'task'),
        things.map((s) => s.payload),
      )
      // "Retry transcription": Whisper runs again, still no speech, the capture stays as it was.
      retryBullet(p.db, id, p.deps)
      const again = await syncUntil(
        p,
        id,
        (x) => x.server_attempts >= 2 && isSettled(x),
        CAPTURE_TIMEOUT,
      )
      record({ type: 'draft_fallback_retry', transitions: again.seen })
      const r = p.db.select().from(bullets).where(eq(bullets.id, id)).get()!
      expect(r.text_from_draft).toBe(true)
      expect(r.server_status).toMatch(/^(processed|needs_review)$/)
    },
    2 * CAPTURE_TIMEOUT,
  )

  test(
    'digital silence ("Thank you." from Whisper) with no draft fails at once as no speech',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'bullet-e2e-'))
      const silence = toneWav(3, 0)
      const path = join(dir, 'silence.wav')
      writeFileSync(path, silence)
      const id = captureVoiceBullet(
        p.db,
        {
          text: 'Voice note, 0:03',
          textEditedByUser: false,
          audio: {
            localPath: path,
            mimeType: 'audio/wav',
            durationMs: wavDurationMs(silence),
            sizeBytes: silence.length,
            sha256: sha256(silence),
          },
          draft: { text: '', engine: 'apple-sfspeechrecognizer', model: null, languages: [] },
        },
        p.deps,
      )
      const t0 = Date.now()
      const seen = await syncUntil(p, id, isSettled, CAPTURE_TIMEOUT)
      const b = p.db.select().from(bullets).where(eq(bullets.id, id)).get()!
      record({
        type: 'silence',
        status: b.server_status,
        error: b.server_error_code,
        message: b.server_error_message,
        attempts: b.server_attempts,
        ms: Date.now() - t0,
        transitions: seen.seen,
      })
      expect(b.server_status).toBe('failed')
      expect(b.server_error_code).toBe('transcription_no_speech')
      expect(b.server_attempts).toBe(1)
      expect(b.text).toBe('Voice note, 0:03')
    },
    CAPTURE_TIMEOUT,
  )

  test(
    'damaged recording: fails at once as transcription_failed; bullet.retry re-queues it',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'bullet-e2e-'))
      const junk = new Uint8Array(40_000).map((_, i) => (i * 7919 + 13) % 251)
      const path = join(dir, 'broken.wav')
      writeFileSync(path, junk)
      const id = captureVoiceBullet(
        p.db,
        {
          text: 'Voice note, 0:05',
          textEditedByUser: false,
          audio: {
            localPath: path,
            mimeType: 'audio/wav',
            durationMs: 5_000,
            sizeBytes: junk.length,
            sha256: sha256(junk),
          },
          draft: { text: '', engine: 'apple-sfspeechrecognizer', model: null, languages: [] },
        },
        p.deps,
      )
      // Decision 1: a recording that can't be decoded fails on the first attempt, no backoff.
      const t0 = Date.now()
      const first = await syncUntil(p, id, (b) => b.server_status === 'failed', CAPTURE_TIMEOUT)
      const b = p.db.select().from(bullets).where(eq(bullets.id, id)).get()!
      record({
        type: 'transcription_failure',
        error: b.server_error_code,
        message: b.server_error_message,
        status: b.server_status,
        attempts: b.server_attempts,
        ms: Date.now() - t0,
        transitions: first.seen,
      })
      expect(b.server_error_code).toBe('transcription_failed')
      expect(b.server_attempts).toBe(1)
      retryBullet(p.db, id, p.deps)
      // The retry runs again (a second attempt), and fails again at once.
      const retried = await syncUntil(
        p,
        id,
        (x) => x.server_attempts >= 2 && x.server_status === 'failed',
        2 * MIN,
      )
      record({ type: 'retry', transitions: retried.seen })
      const r = p.db.select().from(bullets).where(eq(bullets.id, id)).get()!
      expect(r.server_status).toBe('failed')
      expect(retried.seen.length).toBeGreaterThan(0)
    },
    5 * MIN,
  )
})
