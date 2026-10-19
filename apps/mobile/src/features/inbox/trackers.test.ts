/**
 * Decisions 3 and 4 on the phone: a reading of something not tracked yet is decided with its
 * "Start tracking Mood?" card (name editable, the reading it logs underneath); a later reading
 * reads "Log 6 h to Sleep?". All sample content is made up.
 */
import { describe, expect, test } from 'vite-plus/test'
import { acceptSuggestion } from '../../data/local'
import { listOpenQuestions, listPendingSuggestions } from '../../data/queries'
import { questions, suggestions } from '../../data/schema'
import { openTestDb, T0, testDeps } from '../../test/db'
import { inboxCount } from '../capture/counts'
import { seedBullet, seedSuggestion, seedTracker, TZ } from '../journal/fixtures'
import { buildInbox, loadInboxRows, logsLine, trackerNameOrNull } from './model'
import { eq } from 'drizzle-orm'

function seedNewTrackerWithReading() {
  const db = openTestDb()
  const b = seedBullet(db, T0, { text: 'Slept 6 hours.', server_status: 'needs_review' })
  const tracker = seedSuggestion(db, b, {
    target_kind: 'tracker',
    payload: { name: 'Sleep', input_type: 'number', config: { input_type: 'number', unit: 'h' } },
  })
  const reading = seedSuggestion(db, b, {
    target_kind: 'tracker_entry',
    payload: { tracker_id: tracker, value: 6, logged_at: T0 },
  })
  db.insert(questions)
    .values({
      id: '00000000-0000-4000-8000-0000000000a1',
      created_at: 1,
      updated_at: 1,
      source_bullet_id: b,
      source_thought_id: null,
      suggestion_id: tracker,
      kind: 'clarifying',
      topic: 'new_tracker',
      text: 'Start tracking Sleep?',
      options: ['Yes', 'No'],
      status: 'open',
      answer_bullet_id: null,
      resolved_at: null,
    })
    .run()
  return { db, b, tracker, reading }
}

const load = (db: ReturnType<typeof openTestDb>) =>
  loadInboxRows(db, { now: T0, timezone: TZ, heldIds: [] })

describe('a new tracker card', () => {
  test('"Start tracking Sleep?" carries the reading it logs; the reading is not its own item', () => {
    const { db, tracker } = seedNewTrackerWithReading()
    const view = buildInbox(load(db), [])
    expect(view.pendingCount).toBe(1)
    const [item] = view.groups[0]?.items ?? []
    expect(item).toMatchObject({
      id: tracker,
      isNewTracker: true,
      trackerName: 'Sleep',
      logs: ['6 h'],
    })
    expect(item?.summary.ask).toBe('Start tracking Sleep?')
    expect(logsLine(item?.logs ?? [])).toBe('Logs 6 h from this capture')
    // The card asks it: no separate "Start tracking Sleep?" question, and one waiting decision.
    expect(view.questions).toEqual([])
    expect(listOpenQuestions(db)).toEqual([])
    expect(inboxCount(db)).toBe(1)
  })

  test('once the tracker exists, a waiting reading reads "Log 6 h to Sleep?"', () => {
    const db = openTestDb()
    const b = seedBullet(db, T0, { text: 'slept 6h' })
    const sleep = seedTracker(db, 'Sleep', { input_type: 'number', unit: 'h' })
    seedSuggestion(db, b, {
      target_kind: 'tracker_entry',
      operation: 'append',
      target_id: sleep,
      payload: { tracker_id: sleep, value: 6, logged_at: T0 },
    })
    const view = buildInbox(load(db), [])
    expect(view.groups[0]?.items[0]?.summary.ask).toBe('Log 6 h to Sleep?')
    expect(inboxCount(db)).toBe(1)
  })

  test('accepting the tracker on this phone hides its reading until the server logs it', () => {
    const { db, tracker } = seedNewTrackerWithReading()
    acceptSuggestion(db, tracker, testDeps(), {
      name: 'Night sleep',
      input_type: 'number',
      config: { input_type: 'number', unit: 'h' },
    })
    expect(listPendingSuggestions(db)).toEqual([])
    expect(
      db.select().from(suggestions).where(eq(suggestions.id, tracker)).get()?.payload.name,
    ).toBe('Night sleep')
  })

  test('the typed name is trimmed; an empty one cannot be started', () => {
    expect(trackerNameOrNull('  Night   sleep ')).toBe('Night sleep')
    expect(trackerNameOrNull('   ')).toBeNull()
  })
})
