import { describe, expect, test } from 'vite-plus/test'
import { updateTask } from '../../data/local'
import { openTestDb, T0, testDeps } from '../../test/db'
import { seedEvent, seedTask } from './fixtures'
import {
  buildPlans,
  cleanTitle,
  dueInfo,
  END_BEFORE_START,
  eventEditPatch,
  eventMovePatch,
  loadPlanItem,
  loadPlans,
  moveEventStart,
  moveToDay,
  type PlanTask,
} from './plans'

const TZ = 'Europe/Paris'
const H = 3_600_000
const D = 24 * H

const task = (over: Partial<PlanTask>): PlanTask => ({
  id: Math.random().toString(36),
  title: 'task',
  status: 'todo',
  due_at: null,
  created_at: 0,
  updated_at: 0,
  source_bullet_id: null,
  ...over,
})

describe('plans', () => {
  test('events by day, past ones left out; an event under way still shows', () => {
    const plans = buildPlans({
      now: T0,
      tz: TZ,
      tasks: [],
      events: [
        {
          id: 'sat',
          title: 'Birthday dinner',
          starts_at: T0 + 2 * D,
          ends_at: null,
          all_day: false,
          source_bullet_id: null,
        },
        {
          id: 'thu',
          title: 'Dentist',
          starts_at: T0 + 6 * H,
          ends_at: T0 + 7 * H,
          all_day: false,
          source_bullet_id: null,
        },
        {
          id: 'now',
          title: 'Workshop',
          starts_at: T0 - H,
          ends_at: T0 + H,
          all_day: false,
          source_bullet_id: null,
        },
        {
          id: 'past',
          title: 'Over',
          starts_at: T0 - 3 * H,
          ends_at: T0 - 2 * H,
          all_day: false,
          source_bullet_id: null,
        },
        {
          id: 'tue',
          title: 'Gone',
          starts_at: T0 - 2 * D,
          ends_at: null,
          all_day: false,
          source_bullet_id: null,
        },
      ],
    })
    expect(plans.upcoming.map((d) => [d.title, d.short, d.events.map((e) => e.id)])).toEqual([
      ['Today', 'Today', ['now', 'thu']],
      ['Sat 17 Oct', 'Sat 17', ['sat']],
    ])
  })

  test('open tasks by due date (no date last), overdue and today flagged; done recently apart', () => {
    const plans = buildPlans({
      now: T0,
      tz: TZ,
      events: [],
      tasks: [
        task({ id: 'nodate', created_at: 1 }),
        task({ id: 'fri', due_at: T0 + D }),
        task({ id: 'today', due_at: T0 + 3 * H }),
        task({ id: 'late', due_at: T0 - 2 * D }),
        task({ id: 'done', status: 'done', updated_at: T0 - D }),
        task({ id: 'old', status: 'done', updated_at: T0 - 30 * D }),
        task({ id: 'gone', status: 'cancelled' }),
      ],
    })
    expect(plans.open.map((t) => [t.id, t.due.label, t.due.urgency])).toEqual([
      ['late', 'overdue · Tue 13', 'overdue'],
      ['today', 'due today', 'today'],
      ['fri', 'tomorrow', null],
      ['nodate', 'no date', null],
    ])
    expect(plans.doneRecently.map((t) => t.id)).toEqual(['done'])
  })

  test('due labels further out', () => {
    expect(dueInfo(T0 + 3 * D, T0, TZ).label).toBe('Sun')
    expect(dueInfo(T0 + 8 * D, T0, TZ).label).toBe('Fri 23')
  })

  test('the query skips deleted and long-done tasks; completing one moves it to done', () => {
    const db = openTestDb()
    const id = seedTask(db, { title: 'Renew insurance', due_at: T0 + D })
    seedTask(db, { state: 'deleted' })
    seedTask(db, { status: 'done', updated_at: T0 - 30 * D })
    seedEvent(db, T0 + D, { title: 'Flight' })
    seedEvent(db, T0 - 10 * D)
    const deps = testDeps()
    let plans = buildPlans({ ...loadPlans(db, T0), now: T0, tz: TZ })
    expect(plans.open.map((t) => t.title)).toEqual(['Renew insurance'])
    expect(plans.upcoming.flatMap((d) => d.events.map((e) => e.title))).toEqual(['Flight'])
    updateTask(db, id, { status: 'done' }, deps)
    plans = buildPlans({ ...loadPlans(db, T0), now: T0, tz: TZ })
    expect(plans.open).toEqual([])
    expect(plans.doneRecently.map((t) => t.id)).toEqual([id])
  })
})

describe('deep link to one item', () => {
  test('finds old events and long-done or cancelled tasks the lists leave out', () => {
    const db = openTestDb()
    const ev = seedEvent(db, T0 - 8 * D, { title: 'Dentist' })
    const old = seedTask(db, { status: 'done', updated_at: T0 - 30 * D })
    const cancelled = seedTask(db, { status: 'cancelled' })
    const gone = seedTask(db, { state: 'deleted' })
    const plans = buildPlans({ ...loadPlans(db, T0), now: T0, tz: TZ })
    expect(plans.upcoming).toEqual([])
    expect(plans.doneRecently).toEqual([])
    expect(loadPlanItem(db, ev)).toMatchObject({ kind: 'event', event: { title: 'Dentist' } })
    expect(loadPlanItem(db, old)).toMatchObject({ kind: 'task', task: { id: old } })
    expect(loadPlanItem(db, cancelled)).toMatchObject({ kind: 'task' })
    expect(loadPlanItem(db, gone)).toBeNull()
    expect(loadPlanItem(db, 'unknown')).toBeNull()
  })
})

describe('edit sheet', () => {
  test('moving to another day keeps the time of day; no date before means 09:00', () => {
    const at1500 = Date.UTC(2026, 9, 12, 13, 0) // Mon 15:00 Paris
    expect(moveToDay(at1500, 'tomorrow', T0, TZ)).toBe(Date.UTC(2026, 9, 16, 13, 0))
    expect(moveToDay(null, 'today', T0, TZ)).toBe(Date.UTC(2026, 9, 15, 7, 0))
    expect(moveToDay(at1500, 'next_week', T0, TZ)).toBe(Date.UTC(2026, 9, 22, 13, 0))
    // Across the DST change (25 Oct) 15:00 stays 15:00 local.
    const thu = Date.UTC(2026, 9, 22, 7, 0)
    expect(moveToDay(at1500, 'next_week', thu, TZ)).toBe(Date.UTC(2026, 9, 29, 14, 0))
  })

  test('titles are trimmed and never empty', () => {
    expect(cleanTitle('  Call   the bank ')).toBe('Call the bank')
    expect(cleanTitle('   ')).toBeNull()
  })

  test('moving an event keeps its length', () => {
    expect(eventMovePatch({ starts_at: 100, ends_at: 160 }, 200)).toEqual({
      starts_at: 200,
      ends_at: 260,
    })
    expect(eventMovePatch({ starts_at: 100, ends_at: null }, 200)).toEqual({ starts_at: 200 })
    expect(eventMovePatch({ starts_at: 100, ends_at: null }, 100)).toBeNull()
  })

  test('the sheet: a new start carries the end along; No end stays none', () => {
    expect(moveEventStart({ starts_at: 100, ends_at: 160 }, 200)).toEqual({
      starts_at: 200,
      ends_at: 260,
    })
    expect(moveEventStart({ starts_at: 100, ends_at: null }, 200)).toEqual({
      starts_at: 200,
      ends_at: null,
    })
  })

  test('the sheet sends only what changed, ends_at included, and refuses an end before start', () => {
    const e = { title: 'Dentist', starts_at: 100, ends_at: 160 }
    expect(eventEditPatch(e, { ...e })).toEqual({ ok: true, patch: null })
    expect(eventEditPatch(e, { ...e, ends_at: 220 })).toEqual({
      ok: true,
      patch: { ends_at: 220 },
    })
    expect(eventEditPatch(e, { ...e, ends_at: null })).toEqual({
      ok: true,
      patch: { ends_at: null },
    })
    expect(eventEditPatch({ ...e, ends_at: null }, { ...e, starts_at: 130, ends_at: 130 })).toEqual(
      { ok: true, patch: { starts_at: 130, ends_at: 130 } },
    )
    expect(eventEditPatch(e, { ...e, ends_at: 99 })).toEqual({
      ok: false,
      message: END_BEFORE_START,
    })
  })
})
