/**
 * A tracker's history (fix or delete a reading), and an activity's history (read-only: things done
 * come from captures and are changed by editing the capture).
 */

import {
  activityText,
  type EntryData,
  entryValueText,
  loadActivityHistory,
  loadTrackerHistory,
  parseEntryValue,
  type ValueInput,
  valueToInput,
  whenLabel,
} from '@bullet/client'
import type { TrackerConfig, TrackerEntryValue } from '@bullet/core'
import { useState } from 'react'
import { useLocalQuery, useRuntime } from '../app/hooks'
import { useActions, useNav } from '../app/nav'
import { Button, EmptyNote, NavList } from '../ui/primitives'
import { PanelFrame, PanelGone } from './PanelFrame'

export function TrackerHistoryPanel({ id }: { id: string }) {
  const rt = useRuntime()
  const nav = useNav()
  const tz = rt.deps.timezone()
  const now = Date.now()
  const h = useLocalQuery((db) => loadTrackerHistory(db, id), id)
  const [fixing, setFixing] = useState<EntryData | null>(null)
  if (!h.tracker) {
    return (
      <PanelFrame title="Tracker">
        <PanelGone>This tracker isn't here any more.</PanelGone>
      </PanelFrame>
    )
  }
  const config = h.tracker.config
  const items = [
    ...h.entries.map((e) => ({ at: e.logged_at, entry: e, activity: null })),
    ...h.activities.map((a) => ({ at: a.occurred_at, entry: null, activity: a })),
  ].sort((a, b) => b.at - a.at)

  return (
    <PanelFrame title={h.tracker.name}>
      {fixing ? (
        <ReadingEditor
          entry={fixing}
          config={config}
          trackerName={h.tracker.name}
          onDone={() => setFixing(null)}
        />
      ) : (
        <>
          {items.length === 0 ? <EmptyNote>No readings yet.</EmptyNote> : null}
          {items.length > 0 ? (
            <NavList className="rows card">
              {items.map((it) =>
                it.entry ? (
                  <li key={it.entry.id} className="row-item">
                    <button
                      type="button"
                      className="row-main"
                      data-nav
                      aria-label={`${entryValueText(it.entry.value, config)}, ${whenLabel(it.at, now, tz)}${it.entry.user_edited_at ? ', edited by you' : ''}. Fix or delete this reading`}
                      onClick={() => setFixing(it.entry)}
                    >
                      <span className="row-title">{entryValueText(it.entry.value, config)}</span>
                      <span className="caption">
                        {whenLabel(it.at, now, tz)}
                        {it.entry.user_edited_at ? ' · edited by you' : ''}
                      </span>
                    </button>
                    <span className="caption accent">Fix</span>
                  </li>
                ) : it.activity ? (
                  <li key={it.activity.id} className="row-item">
                    <button
                      type="button"
                      className="row-main"
                      data-nav
                      disabled={!it.activity.source_bullet_id}
                      onClick={() =>
                        it.activity?.source_bullet_id &&
                        nav.openPanel({ kind: 'capture', id: it.activity.source_bullet_id })
                      }
                    >
                      <span className="row-title">
                        {activityText(it.activity) ?? it.activity.name}
                      </span>
                      <span className="caption">{whenLabel(it.at, now, tz)}</span>
                    </button>
                  </li>
                ) : null,
              )}
            </NavList>
          ) : null}
        </>
      )}
    </PanelFrame>
  )
}

const range = (lo: number, hi: number) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)

function sameValue(a: TrackerEntryValue, b: TrackerEntryValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function ReadingEditor({
  entry,
  config,
  trackerName,
  onDone,
}: {
  entry: EntryData
  config: TrackerConfig
  trackerName: string
  onDone: () => void
}) {
  const nav = useNav()
  const actions = useActions()
  const [input, setInput] = useState<ValueInput>(valueToInput(entry.value))
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const set = (v: ValueInput) => {
    setInput(v)
    setError(null)
  }
  const save = () => {
    const parsed = parseEntryValue(input, config)
    if (!parsed.ok) {
      setError(parsed.error)
      return
    }
    try {
      if (!sameValue(parsed.value, entry.value)) actions.fixReading(entry.id, parsed.value)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const chips = (
    options: { label: string; value: ValueInput; selected: boolean; aria?: string }[],
  ) => (
    <fieldset className="choices">
      <legend className="field-label">Fix this reading</legend>
      {options.map((o) => (
        <Button
          key={o.label}
          variant="option"
          aria-pressed={o.selected}
          aria-label={o.aria}
          onClick={() => set(o.value)}
        >
          {o.label}
        </Button>
      ))}
    </fieldset>
  )
  const typed = (label: string, mode?: 'decimal') => (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        type="text"
        inputMode={mode}
        value={typeof input === 'string' ? input : ''}
        onChange={(e) => set(e.target.value)}
      />
    </label>
  )

  let field: React.ReactNode
  switch (config.input_type) {
    case 'scale':
      field =
        config.max - config.min <= 10
          ? chips(
              range(config.min, config.max).map((n) => ({
                label: String(n),
                value: String(n),
                selected: input === String(n),
                aria: `${n} of ${config.max}`,
              })),
            )
          : typed(trackerName, 'decimal')
      break
    case 'number':
      field = typed(`${trackerName}${config.unit ? ` in ${config.unit}` : ''}`, 'decimal')
      break
    case 'boolean':
      field = chips([
        { label: 'Yes', value: true, selected: input === true },
        { label: 'No', value: false, selected: input === false },
      ])
      break
    case 'single_select':
      field = chips(config.options.map((o) => ({ label: o, value: o, selected: input === o })))
      break
    case 'multi_select': {
      const chosen = Array.isArray(input) ? input : []
      field = chips(
        config.options.map((o) => ({
          label: o,
          value: chosen.includes(o) ? chosen.filter((x) => x !== o) : [...chosen, o],
          selected: chosen.includes(o),
        })),
      )
      break
    }
    case 'text':
      field = (
        <label className="field">
          <span className="field-label">{trackerName}</span>
          <textarea
            rows={3}
            value={typeof input === 'string' ? input : ''}
            onChange={(e) => set(e.target.value)}
          />
        </label>
      )
      break
  }

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      {field}
      {error ? (
        <p className="warn" role="alert">
          {error}
        </p>
      ) : null}
      <div className="row">
        <Button variant="primary" type="submit">
          Save
        </Button>
        <Button variant="quiet" onClick={onDone}>
          Back
        </Button>
        {entry.source_bullet_id ? (
          <Button
            onClick={() => nav.openPanel({ kind: 'capture', id: entry.source_bullet_id as string })}
          >
            Open capture
          </Button>
        ) : null}
      </div>
      <div className="danger-zone">
        {confirming ? (
          <div role="alertdialog" aria-labelledby="del-reading" className="confirm">
            <h3 id="del-reading">Delete this reading?</h3>
            <p>The {trackerName} reading goes away. The capture stays.</p>
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
                  actions.removeReading(entry.id)
                  onDone()
                }}
              >
                Delete
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="danger" onClick={() => setConfirming(true)}>
            Delete reading
          </Button>
        )}
      </div>
    </form>
  )
}

export function ActivityHistoryPanel({ name }: { name: string }) {
  const rt = useRuntime()
  const nav = useNav()
  const tz = rt.deps.timezone()
  const now = Date.now()
  const acts = useLocalQuery((db) => loadActivityHistory(db, name), name)
  return (
    <PanelFrame title={acts[0]?.name.trim() ?? name}>
      {acts.length === 0 ? <EmptyNote>Nothing logged.</EmptyNote> : null}
      {acts.length > 0 ? (
        <NavList className="rows card">
          {acts.map((a) => (
            <li key={a.id} className="row-item">
              <button
                type="button"
                className="row-main"
                data-nav
                disabled={!a.source_bullet_id}
                onClick={() =>
                  a.source_bullet_id && nav.openPanel({ kind: 'capture', id: a.source_bullet_id })
                }
              >
                <span className="row-title">{activityText(a) ?? a.name}</span>
                <span className="caption">{whenLabel(a.occurred_at, now, tz)}</span>
              </button>
            </li>
          ))}
        </NavList>
      ) : null}
      <p className="caption">To change one, edit the capture it came from.</p>
    </PanelFrame>
  )
}
