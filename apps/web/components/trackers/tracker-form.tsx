'use client'

/**
 * The tracker create/edit form — one component for both. Name + an input-type picker + a
 * type-specific config editor (scale bounds & end-labels · number unit · select options). The same
 * form Review fills in when it proposes a new tracker; here it's yours to write.
 *
 * A controlled local draft; the page owns persistence. All option/type metadata comes from the
 * view-model, so this stays declarative. Editing an existing tracker's type is allowed, but a
 * quiet note warns that switching type can't cleanly convert past entries (v1: the switch is
 * permitted; history keeps its raw values).
 */

import { useEffect, useId, useRef, useState } from 'react'
import {
  canSubmitTracker,
  INPUT_TYPE_META,
  INPUT_TYPE_ORDER,
  isSelectType,
  type TrackerFormValues,
} from '@/lib/trackers-view-model'
import type { TrackerInputType } from '@/lib/types'
import { cn } from '@/lib/utils'

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 font-data text-[10px] text-faint-2 uppercase tracking-[0.12em]">
      {children}
    </div>
  )
}

export function TrackerForm({
  heading,
  submitLabel,
  initial,
  isEdit,
  hasEntries,
  busy,
  notice,
  onSubmit,
  onCancel,
  onDelete,
}: {
  heading: string
  submitLabel: string
  initial: TrackerFormValues
  isEdit: boolean
  /** Whether the tracker being edited already has logged entries (drives the type-change note). */
  hasEntries: boolean
  busy: boolean
  notice?: string | null
  onSubmit: (values: TrackerFormValues) => void
  onCancel: () => void
  onDelete?: () => void
}) {
  const [values, setValues] = useState<TrackerFormValues>(initial)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const nameId = useId()

  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  const set = <K extends keyof TrackerFormValues>(key: K, val: TrackerFormValues[K]) =>
    setValues((v) => ({ ...v, [key]: val }))

  const typeChanged = isEdit && values.input_type !== initial.input_type
  const canSubmit = canSubmitTracker(values) && !busy

  return (
    <div className="px-10 pt-[30px] pb-12 max-md:px-5 max-md:pt-6">
      <div className="mx-auto max-w-[600px]">
        <button
          type="button"
          onClick={onCancel}
          className="mb-4 inline-flex items-center gap-[6px] font-data text-[11px] text-faint-2 transition-colors hover:text-ochre"
        >
          ← all trackers
        </button>

        <div className="mb-1 flex items-center gap-[10px]">
          <span className="font-data text-[16px] text-ochre">—</span>
          <h2 className="m-0 font-display text-[30px] text-ink max-md:text-[24px]">{heading}</h2>
        </div>
        <p className="mb-[22px] font-reader text-[15px] text-muted">
          The same form Review fills in when it spots something new worth tracking.
        </p>

        <div className="rounded-[14px] border border-line bg-white px-6 pt-[22px] pb-6 shadow-[0_2px_12px_-8px_rgba(0,0,0,0.14)]">
          <FieldLabel>Name</FieldLabel>
          <label htmlFor={nameId} className="sr-only">
            Tracker name
          </label>
          <input
            ref={nameRef}
            id={nameId}
            value={values.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="What are you tracking?"
            className="mb-5 w-full rounded-[9px] border border-line-warm bg-panel px-[13px] py-[11px] font-reader text-[20px] text-ink placeholder:text-faint-3 focus:border-ochre focus:outline-none"
          />

          <fieldset className="m-0 mb-5 min-w-0 border-0 p-0">
            <legend className="mb-2 p-0 font-data text-[10px] text-faint-2 uppercase tracking-[0.12em]">
              Input type
            </legend>
            <div className="grid grid-cols-2 gap-2 max-md:grid-cols-1">
              {INPUT_TYPE_ORDER.map((t) => (
                <TypeOption
                  key={t}
                  type={t}
                  selected={values.input_type === t}
                  onClick={() => set('input_type', t)}
                />
              ))}
            </div>
          </fieldset>

          <ConfigEditor values={values} set={set} />

          {typeChanged && hasEntries && (
            <div className="mt-4 rounded-[11px] border border-[#e9d9b8] bg-[#fbf4e9] px-[17px] py-[13px]">
              <div className="mb-1 flex items-center gap-2 font-ui font-semibold text-[13px] text-[#7a5a1e]">
                <span className="font-data text-ochre">△</span>
                Changing the input type
              </div>
              <p className="m-0 font-ui text-[12.5px] text-[#7a6a48] leading-relaxed">
                This tracker already has entries. Switching type keeps your past readings as-is —
                they just won't reformat to the new schema.
              </p>
            </div>
          )}
        </div>

        {notice && (
          <p className="mt-3 text-right font-ui text-[12.5px] text-rust" role="alert">
            {notice}
          </p>
        )}

        <div className="mt-[18px] flex items-center justify-end gap-3">
          {isEdit &&
            onDelete &&
            (confirmDelete ? (
              <span className="mr-auto inline-flex items-center gap-2 font-ui text-[13px] text-muted-soft">
                Delete this tracker?
                <button
                  type="button"
                  disabled={busy}
                  onClick={onDelete}
                  className="font-medium text-rust hover:underline disabled:opacity-50"
                >
                  Delete
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="text-faint hover:text-muted-soft"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="mr-auto font-ui text-[13px] text-faint transition-colors hover:text-rust"
              >
                Delete
              </button>
            ))}
          <button
            type="button"
            onClick={onCancel}
            className="px-2 py-[9px] font-ui text-[14px] text-faint transition-colors hover:text-muted-soft"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => onSubmit(values)}
            className="rounded-[23px] bg-ochre px-[22px] py-[11px] font-ui font-medium text-[14px] text-white transition-colors hover:bg-ochre-deep disabled:cursor-not-allowed disabled:bg-line-warm disabled:text-faint-3"
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function TypeOption({
  type,
  selected,
  onClick,
}: {
  type: TrackerInputType
  selected: boolean
  onClick: () => void
}) {
  const meta = INPUT_TYPE_META[type]
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'flex items-start gap-[10px] rounded-[10px] border px-[13px] py-3 text-left transition-colors',
        selected ? 'border-ochre bg-ochre-wash' : 'border-line-warm bg-panel hover:border-ochre',
      )}
    >
      <span
        className={cn('mt-[1px] font-data text-[15px]', selected ? 'text-ochre' : 'text-faint-2')}
      >
        {meta.glyph}
      </span>
      <span>
        <span className="block font-ui font-medium text-[13.5px] text-ink">{meta.label}</span>
        <span className="mt-[1px] block font-ui text-[11.5px] text-faint">{meta.hint}</span>
      </span>
    </button>
  )
}

/** The type-specific config editor — narrows on `values.input_type`. */
function ConfigEditor({
  values,
  set,
}: {
  values: TrackerFormValues
  set: <K extends keyof TrackerFormValues>(key: K, val: TrackerFormValues[K]) => void
}) {
  const panel = 'rounded-[10px] border border-[#efede6] bg-panel px-4 py-[15px]'
  const smallLabel = 'mb-[5px] block font-ui text-[12px] text-faint'
  const cell =
    'rounded-[8px] border border-line-warm bg-white px-[10px] py-2 focus:border-ochre focus:outline-none'

  if (values.input_type === 'scale') {
    return (
      <div className={panel}>
        <div className="mb-[10px] font-data text-[10px] text-faint-2 uppercase tracking-[0.1em]">
          Scale · {values.scaleMin} to {values.scaleMax}
        </div>
        <div className="mb-3 flex gap-5">
          <label>
            <span className={smallLabel}>Lowest</span>
            <input
              type="number"
              value={values.scaleMin}
              onChange={(e) => set('scaleMin', Number(e.target.value))}
              className={cn(cell, 'w-[64px] text-center font-data text-[15px] text-ink')}
            />
          </label>
          <label>
            <span className={smallLabel}>Highest</span>
            <input
              type="number"
              value={values.scaleMax}
              onChange={(e) => set('scaleMax', Number(e.target.value))}
              className={cn(cell, 'w-[64px] text-center font-data text-[15px] text-ink')}
            />
          </label>
        </div>
        <div className="flex gap-[10px] max-md:flex-col">
          <label className="flex-1">
            <span className={smallLabel}>Label the low end</span>
            <input
              value={values.lowLabel}
              onChange={(e) => set('lowLabel', e.target.value)}
              placeholder="Low"
              className={cn(cell, 'w-full font-ui text-[13px] text-ink')}
            />
          </label>
          <label className="flex-1">
            <span className={smallLabel}>Label the high end</span>
            <input
              value={values.highLabel}
              onChange={(e) => set('highLabel', e.target.value)}
              placeholder="Great"
              className={cn(cell, 'w-full font-ui text-[13px] text-ink')}
            />
          </label>
        </div>
      </div>
    )
  }

  if (values.input_type === 'number') {
    return (
      <div className={panel}>
        <div className="mb-[10px] font-data text-[10px] text-faint-2 uppercase tracking-[0.1em]">
          Number
        </div>
        <label className="block">
          <span className={smallLabel}>Unit (optional)</span>
          <input
            value={values.unit}
            onChange={(e) => set('unit', e.target.value)}
            placeholder="cups, km, hours…"
            className={cn(cell, 'w-full max-w-[220px] font-ui text-[13px] text-ink')}
          />
        </label>
      </div>
    )
  }

  if (isSelectType(values.input_type)) {
    return <OptionsEditor values={values} set={set} panel={panel} />
  }

  // boolean / text
  return (
    <div className={cn(panel, 'font-ui text-[13px] text-faint')}>
      {values.input_type === 'boolean'
        ? 'A simple did-it / didn’t. Logging one marks the day done.'
        : 'A free-text note logged against a date. Good for one-liners and reflections.'}
    </div>
  )
}

function OptionsEditor({
  values,
  set,
  panel,
}: {
  values: TrackerFormValues
  set: <K extends keyof TrackerFormValues>(key: K, val: TrackerFormValues[K]) => void
  panel: string
}) {
  const setOption = (i: number, text: string) =>
    set(
      'options',
      values.options.map((o, idx) => (idx === i ? text : o)),
    )
  const removeOption = (i: number) =>
    set(
      'options',
      values.options.filter((_, idx) => idx !== i),
    )
  const addOption = () => set('options', [...values.options, ''])

  return (
    <div className={panel}>
      <div className="mb-[10px] font-data text-[10px] text-faint-2 uppercase tracking-[0.1em]">
        Options
      </div>
      <div className="flex flex-col gap-[7px]">
        {values.options.map((opt, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: positional option rows (order is meaningful, values may repeat while typing)
            key={i}
            className="flex items-center gap-2 rounded-[8px] border border-line-warm bg-white px-[10px] py-[6px]"
          >
            <span className="font-data text-faint-3">≡</span>
            <input
              value={opt}
              onChange={(e) => setOption(i, e.target.value)}
              placeholder={`Option ${i + 1}`}
              className="min-w-0 flex-1 bg-transparent font-ui text-[13.5px] text-ink focus:outline-none"
            />
            {values.options.length > 1 && (
              <button
                type="button"
                onClick={() => removeOption(i)}
                aria-label={`Remove option ${i + 1}`}
                className="font-ui text-[14px] text-faint-3 transition-colors hover:text-rust"
              >
                ✕
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={addOption}
          className="self-start font-ui text-[12.5px] text-ochre transition-colors hover:text-ochre-deep"
        >
          + Add option
        </button>
      </div>
    </div>
  )
}
