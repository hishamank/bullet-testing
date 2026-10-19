/**
 * Edit a task or an event: rename, reschedule (quick days, or the date and time fields), delete.
 * The checks and the date math are `@bullet/client` (`features/journal/plans`).
 */

import {
  cleanTitle,
  DAY_CHOICES,
  type DayChoice,
  DEFAULT_EVENT_LENGTH_MS,
  eventEditPatch,
  fullWhen,
  loadPlanItem,
  moveEventStart,
  moveToDay,
} from '@bullet/client'
import { useState } from 'react'
import { fromLocalInput, toLocalInput } from '../app/datetime'
import { useLocalQuery, useRuntime } from '../app/hooks'
import { useActions, useNav } from '../app/nav'
import { Button } from '../ui/primitives'
import { PanelFrame, PanelGone } from './PanelFrame'

type Item = NonNullable<ReturnType<typeof loadPlanItem>>

export function PlanEditPanel({ id }: { id: string }) {
  const item = useLocalQuery((db) => loadPlanItem(db, id), id)
  if (!item) {
    return (
      <PanelFrame title="Edit">
        <PanelGone>This is gone, so there's nothing to edit.</PanelGone>
      </PanelFrame>
    )
  }
  return <EditBody key={id} item={item} />
}

function EditBody({ item }: { item: Item }) {
  const rt = useRuntime()
  const nav = useNav()
  const actions = useActions()
  const tz = rt.deps.timezone()
  const now = Date.now()
  const isTask = item.kind === 'task'
  const original = isTask
    ? { title: item.task.title, at: item.task.due_at }
    : { title: item.event.title, at: item.event.starts_at as number | null }
  const [title, setTitle] = useState(original.title)
  const [at, setAtState] = useState<number | null>(original.at)
  const [end, setEnd] = useState<number | null>(isTask ? null : item.event.ends_at)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const noun = isTask ? 'task' : 'event'
  const sourceBullet = isTask ? item.task.source_bullet_id : item.event.source_bullet_id

  /** A new start carries an event's end along (same length). */
  const setAt = (next: number | null) => {
    if (!isTask && at !== null && next !== null) {
      setEnd(moveEventStart({ starts_at: at, ends_at: end }, next).ends_at)
    }
    setAtState(next)
    setError(null)
  }
  const choose = (c: DayChoice) => setAt(c === 'none' ? null : moveToDay(at, c, now, tz))

  const save = () => {
    const name = cleanTitle(title)
    if (!name) {
      setError('Give it a name.')
      return
    }
    try {
      if (item.kind === 'task') {
        const patch = {
          ...(name !== item.task.title ? { title: name } : {}),
          ...(at !== item.task.due_at ? { due_at: at } : {}),
        }
        if (Object.keys(patch).length > 0) actions.editTask(item.task.id, patch)
      } else {
        const r = eventEditPatch(item.event, {
          title: name,
          starts_at: at ?? item.event.starts_at,
          ends_at: end,
        })
        if (!r.ok) {
          setError(r.message)
          return
        }
        if (r.patch) actions.editEvent(item.event.id, r.patch)
      }
      nav.closePanel()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const choices = isTask ? DAY_CHOICES : DAY_CHOICES.filter((c) => c.id !== 'none')
  return (
    <PanelFrame title={isTask ? 'Edit task' : 'Edit event'}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <label className="field">
          <span className="field-label">Name</span>
          <input
            type="text"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value)
              setError(null)
            }}
          />
        </label>
        <fieldset className="choices">
          <legend className="field-label">{isTask ? 'Due' : 'When'}</legend>
          <p className="grow" aria-live="polite">
            {at === null ? 'No date' : fullWhen(at, now, tz)}
          </p>
          {choices.map((c) => (
            <Button
              key={c.id}
              variant="option"
              aria-pressed={c.id === 'none' && at === null}
              aria-label={c.id === 'none' ? 'No date' : `Move to ${c.label.toLowerCase()}`}
              onClick={() => choose(c.id)}
            >
              {c.label}
            </Button>
          ))}
        </fieldset>
        <label className="field">
          <span className="field-label">{isTask ? 'Due date and time' : 'Starts'}</span>
          <input
            type="datetime-local"
            value={at === null ? '' : toLocalInput(at)}
            onChange={(e) => setAt(fromLocalInput(e.target.value))}
          />
        </label>
        {!isTask && at !== null ? (
          <>
            <label className="field">
              <span className="field-label">Ends</span>
              <input
                type="datetime-local"
                value={end === null ? '' : toLocalInput(end)}
                min={toLocalInput(at)}
                onChange={(e) => {
                  setEnd(fromLocalInput(e.target.value))
                  setError(null)
                }}
              />
            </label>
            <div className="row">
              <Button
                variant="quiet"
                aria-pressed={end === null}
                onClick={() => {
                  setEnd(null)
                  setError(null)
                }}
              >
                No end
              </Button>
              {end === null ? (
                <Button variant="quiet" onClick={() => setEnd(at + DEFAULT_EVENT_LENGTH_MS)}>
                  An hour long
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
        {error ? (
          <p className="warn" role="alert">
            {error}
          </p>
        ) : null}
        <div className="row">
          <Button variant="primary" type="submit">
            Save
          </Button>
          {sourceBullet ? (
            <Button onClick={() => nav.openPanel({ kind: 'capture', id: sourceBullet })}>
              Open capture
            </Button>
          ) : null}
        </div>
      </form>
      <div className="danger-zone">
        {confirming ? (
          <div role="alertdialog" aria-labelledby="del-plan" className="confirm">
            <h3 id="del-plan">Delete this {noun}?</h3>
            <p>“{original.title}” goes away. The capture stays.</p>
            <div className="row">
              <Button
                // oxlint-disable-next-line jsx-a11y/no-autofocus -- the safe choice gets focus
                autoFocus
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  if (item.kind === 'task') actions.removeTask(item.task.id)
                  else actions.removeEvent(item.event.id)
                  nav.closePanel()
                }}
              >
                Delete
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="danger" onClick={() => setConfirming(true)}>
            Delete {noun}
          </Button>
        )}
      </div>
    </PanelFrame>
  )
}
