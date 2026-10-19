/** Edit a waiting suggestion, then add it with the changes (`suggestion.accept` + payload). */

import { applyEdit, type EditForm, editFormFor, loadEditable, payloadChanged } from '@bullet/client'
import type { TrackerConfig, TrackerEntryValue } from '@bullet/core'
import { useState } from 'react'
import { fromLocalInput, toLocalInput } from '../app/datetime'
import { useLocalQuery, useRuntime } from '../app/hooks'
import { useNav } from '../app/nav'
import { Button, KindPill } from '../ui/primitives'
import { PanelFrame, PanelGone } from './PanelFrame'

export function EditSuggestionPanel({ id }: { id: string }) {
  const rt = useRuntime()
  const nav = useNav()
  const loaded = useLocalQuery((db) => loadEditable(db, id, Date.now(), rt.deps.timezone()), id)
  const [form, setForm] = useState<EditForm | null>(() => (loaded ? editFormFor(loaded.s) : null))
  const [error, setError] = useState<string | null>(null)

  if (!loaded || !form) {
    return (
      <PanelFrame title="Edit">
        <PanelGone>This was already decided, so there's nothing to edit.</PanelGone>
      </PanelFrame>
    )
  }
  const { s, summary, tracker } = loaded

  const save = () => {
    const result = applyEdit(s, form, tracker?.config)
    if (!result.ok) {
      setError(result.message)
      return
    }
    rt.inbox.accept(
      s.id,
      summary.spoken,
      payloadChanged(s.payload, result.payload) ? result.payload : undefined,
    )
    nav.closePanel()
  }

  return (
    <PanelFrame title="Edit">
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <div>
          <KindPill kind={summary.pill.kind} label={summary.pill.label} />
        </div>
        <Fields
          form={form}
          tracker={tracker}
          onChange={(f) => {
            setForm(f)
            setError(null)
          }}
        />
        {error ? (
          <p className="warn" role="alert">
            {error}
          </p>
        ) : null}
        <div className="row">
          <Button variant="primary" type="submit">
            Add with changes
          </Button>
          <Button variant="quiet" onClick={() => nav.closePanel()}>
            Cancel
          </Button>
        </div>
      </form>
    </PanelFrame>
  )
}

function Field({
  label,
  value,
  onChange,
  inputMode,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  inputMode?: 'decimal'
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        type="text"
        inputMode={inputMode}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}

function WhenField({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (ms: number) => void
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        type="datetime-local"
        value={toLocalInput(value)}
        onChange={(e) => {
          const ms = fromLocalInput(e.target.value)
          if (ms !== null) onChange(ms)
        }}
      />
    </label>
  )
}

function Fields({
  form,
  tracker,
  onChange,
}: {
  form: EditForm
  tracker: { name: string; config: TrackerConfig } | null
  onChange: (f: EditForm) => void
}) {
  switch (form.kind) {
    case 'task':
      return (
        <>
          <Field
            label="Title"
            value={form.title}
            onChange={(title) => onChange({ ...form, title })}
          />
          {form.due_at === null ? (
            <div>
              <Button onClick={() => onChange({ ...form, due_at: Date.now() + 86_400_000 })}>
                Add a due date
              </Button>
            </div>
          ) : (
            <div className="row end-align">
              <div className="grow">
                <WhenField
                  label="Due"
                  value={form.due_at}
                  onChange={(due_at) => onChange({ ...form, due_at })}
                />
              </div>
              <Button variant="quiet" onClick={() => onChange({ ...form, due_at: null })}>
                No due date
              </Button>
            </div>
          )}
        </>
      )
    case 'event':
      return (
        <>
          <Field
            label="Title"
            value={form.title}
            onChange={(title) => onChange({ ...form, title })}
          />
          <WhenField
            label="Starts"
            value={form.starts_at}
            onChange={(starts_at) => onChange({ ...form, starts_at })}
          />
        </>
      )
    case 'tracker':
      return (
        <Field label="Name" value={form.name} onChange={(name) => onChange({ ...form, name })} />
      )
    case 'activity':
      return (
        <>
          <Field
            label="What you did"
            value={form.name}
            onChange={(name) => onChange({ ...form, name })}
          />
          <Field
            label="Amount (optional)"
            value={form.quantity}
            inputMode="decimal"
            onChange={(quantity) => onChange({ ...form, quantity })}
          />
        </>
      )
    case 'tracker_entry':
      return (
        <ValueField
          name={tracker?.name ?? 'Reading'}
          config={tracker?.config ?? null}
          value={form.value}
          onChange={(value) => onChange({ ...form, value })}
        />
      )
  }
}

type Choice = { title: string; value: TrackerEntryValue; selected: boolean }

/** A reading's value, shaped by its tracker: scale/select/boolean as buttons, else typed. */
function ValueField({
  name,
  config,
  value,
  onChange,
}: {
  name: string
  config: TrackerConfig | null
  value: TrackerEntryValue
  onChange: (v: TrackerEntryValue) => void
}) {
  const choices = (options: Choice[]) => (
    <fieldset className="choices">
      <legend className="field-label">{name}</legend>
      {options.map((o) => (
        <Button
          key={o.title}
          variant="option"
          aria-pressed={o.selected}
          aria-label={`${name} ${o.title}`}
          onClick={() => onChange(o.value)}
        >
          {o.title}
        </Button>
      ))}
    </fieldset>
  )
  if (config?.input_type === 'scale' && config.max - config.min <= 10) {
    const steps = Array.from({ length: config.max - config.min + 1 }, (_, i) => config.min + i)
    return choices(steps.map((n) => ({ title: String(n), value: n, selected: value === n })))
  }
  if (config?.input_type === 'boolean' || typeof value === 'boolean') {
    return choices([
      { title: 'Yes', value: true, selected: value === true },
      { title: 'No', value: false, selected: value === false },
    ])
  }
  if (config?.input_type === 'single_select') {
    return choices(config.options.map((o) => ({ title: o, value: o, selected: value === o })))
  }
  if (config?.input_type === 'multi_select') {
    const picked = Array.isArray(value) ? value : []
    return choices(
      config.options.map((o) => ({
        title: o,
        value: picked.includes(o) ? picked.filter((p) => p !== o) : [...picked, o],
        selected: picked.includes(o),
      })),
    )
  }
  if (typeof value === 'number')
    return <NumberField name={name} value={value} onChange={onChange} />
  return <Field label={name} value={String(value)} onChange={onChange} />
}

/** A typed number; keeps the raw text while it isn't a number yet. */
function NumberField({
  name,
  value,
  onChange,
}: {
  name: string
  value: number
  onChange: (v: TrackerEntryValue) => void
}) {
  const [raw, setRaw] = useState(String(value))
  return (
    <Field
      label={name}
      value={raw}
      inputMode="decimal"
      onChange={(text) => {
        setRaw(text)
        const n = Number(text.replace(',', '.'))
        if (text.trim() !== '' && Number.isFinite(n)) onChange(n)
      }}
    />
  )
}
