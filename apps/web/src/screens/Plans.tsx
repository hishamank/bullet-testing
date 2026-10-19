/**
 * Journal · plans: what's coming up, open tasks by due date, and tasks done recently. Check a
 * task off, or open an item to rename, reschedule or delete it.
 */

import { buildPlans, clock, loadPlans, type PlanTask } from '@bullet/client'
import { Fragment, useState } from 'react'
import { useLocalQuery, useRuntime } from '../app/hooks'
import { useActions, useNav } from '../app/nav'
import { Bidi, Checkbox, Disclosure, EmptyNote, NavList, SectionTitle } from '../ui/primitives'

export function Plans() {
  const rt = useRuntime()
  const nav = useNav()
  const actions = useActions()
  const tz = rt.deps.timezone()
  const now = Date.now()
  const data = useLocalQuery((db) => loadPlans(db, Date.now()))
  const plans = buildPlans({ ...data, now, tz })
  const [showDone, setShowDone] = useState(false)
  const empty = plans.upcoming.length === 0 && plans.open.length === 0

  const taskRow = (
    task: PlanTask,
    due: { label: string; urgency: 'overdue' | 'today' | null } | null,
  ) => {
    const done = task.status === 'done'
    return (
      <li key={task.id} className="row-item">
        <Checkbox
          checked={done}
          label={`Done: ${task.title}`}
          onChange={(next) => actions.setTaskDone(task.id, next)}
        />
        <button
          type="button"
          className="row-main row-inline"
          data-nav
          aria-label={[task.title, due?.label].filter(Boolean).join(', ')}
          onClick={() => nav.openPanel({ kind: 'plan', id: task.id })}
        >
          <Bidi text={task.title} className={`row-title${done ? ' struck' : ''}`} />
          {due ? (
            <span className={`due${due.urgency ? ` due-${due.urgency}` : ''}`}>{due.label}</span>
          ) : null}
        </button>
      </li>
    )
  }

  return (
    <div className="journal-page">
      {empty ? (
        <EmptyNote>
          Nothing planned yet. Events and tasks you mention in a capture show up here.
        </EmptyNote>
      ) : null}
      {plans.upcoming.length > 0 ? (
        <section aria-label="Coming up">
          <SectionTitle>Coming up</SectionTitle>
          <NavList className="rows card">
            {plans.upcoming.map((day) => (
              <Fragment key={day.key}>
                {day.events.map((e, i) => (
                  <li key={e.id} className="row-item">
                    <span className="day-col caption">{i === 0 ? day.short : ''}</span>
                    <button
                      type="button"
                      className="row-main row-inline"
                      data-nav
                      aria-label={`${day.title}, ${e.title}${e.all_day ? '' : `, ${clock(e.starts_at, tz)}`}`}
                      onClick={() => nav.openPanel({ kind: 'plan', id: e.id })}
                    >
                      <Bidi text={e.title} className="row-title" />
                      {e.all_day ? null : <span className="caption">{clock(e.starts_at, tz)}</span>}
                    </button>
                  </li>
                ))}
              </Fragment>
            ))}
          </NavList>
        </section>
      ) : null}
      {plans.open.length > 0 ? (
        <section aria-label="Tasks">
          <SectionTitle>Tasks</SectionTitle>
          <NavList className="rows card">{plans.open.map((t) => taskRow(t, t.due))}</NavList>
        </section>
      ) : null}
      {plans.doneRecently.length > 0 ? (
        <section>
          <Disclosure
            title={`Done recently · ${plans.doneRecently.length}`}
            open={showDone}
            onToggle={() => setShowDone((v) => !v)}
          />
          {showDone ? (
            <NavList className="rows card">
              {plans.doneRecently.map((t) => taskRow(t, null))}
            </NavList>
          ) : null}
        </section>
      ) : null}
      {!empty ? (
        <p className="hint-text">Open an item to reschedule, rename or delete it.</p>
      ) : null}
    </div>
  )
}
