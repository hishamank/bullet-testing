'use client'

/**
 * The task form — one component for both create (empty) and edit-in-place (pre-filled). This is
 * the "same form Review fills in for you", here yours to write: Title, Status, Due, Priority, Notes.
 *
 * It's a controlled local draft; the page owns persistence (create / update mutations). No natural-
 * language date parsing (out of scope) — Due offers a few honest relative presets resolved to
 * epoch-ms. All chip configs come from the view-model, so this stays purely declarative.
 */

import { useEffect, useId, useRef, useState } from 'react'
import {
  canSubmitTask,
  dueChipTargets,
  matchDueChip,
  PRIORITY_CHIPS,
  STATUS_CHIPS,
  type TaskFormValues,
} from '@/lib/tasks-view-model'
import { cn } from '@/lib/utils'

function Chip({
  selected,
  onClick,
  disabled,
  children,
}: {
  selected: boolean
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-[6px] rounded-lg border px-3 py-[6px] font-ui text-[12.5px] transition-colors disabled:opacity-50',
        selected
          ? 'border-indigo bg-indigo text-white'
          : 'border-line-cool bg-white text-muted-soft hover:border-indigo',
      )}
    >
      {children}
    </button>
  )
}

function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: React.ReactNode }) {
  return (
    <label
      htmlFor={htmlFor}
      className="mb-2 block font-data text-[10px] text-faint-2 uppercase tracking-[0.12em]"
    >
      {children}
    </label>
  )
}

export function TaskForm({
  heading,
  submitLabel,
  initial,
  isEdit,
  busy,
  notice,
  onSubmit,
  onCancel,
  onDelete,
}: {
  heading: string
  submitLabel: string
  initial: TaskFormValues
  isEdit: boolean
  busy: boolean
  /** A submit error to surface on the form (the mutation kept the user here). */
  notice?: string | null
  onSubmit: (values: TaskFormValues) => void
  onCancel: () => void
  /** Present only in edit mode — a quiet, confirm-guarded soft-delete. */
  onDelete?: () => void
}) {
  const [values, setValues] = useState<TaskFormValues>(initial)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // Track the chosen due preset directly, so highlighting never mis-resolves when two presets
  // land on the same day (e.g. "Tomorrow" and "This week" both = Friday on a Thursday).
  const [dueKey, setDueKey] = useState<string | null>(() => matchDueChip(initial.due_at))
  const titleRef = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const notesId = useId()

  // Focus the title on open — the one field every task needs — without the flagged autoFocus attr.
  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  const set = <K extends keyof TaskFormValues>(key: K, val: TaskFormValues[K]) =>
    setValues((v) => ({ ...v, [key]: val }))

  const pickDue = (key: string, ms: number | null) => {
    setDueKey(key)
    set('due_at', ms)
  }

  const canSubmit = canSubmitTask(values) && !busy

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    onSubmit({ ...values, title: values.title.trim() })
  }

  return (
    <div className="px-10 pt-[34px] pb-12 max-md:px-5 max-md:pt-6">
      <div className="mx-auto max-w-[620px]">
        <button
          type="button"
          onClick={onCancel}
          className="mb-4 inline-flex items-center gap-[6px] font-data text-[11px] text-faint-2 transition-colors hover:text-indigo"
        >
          ← back to tasks
        </button>

        <div className="mb-1 flex items-center gap-[10px]">
          <span className="font-data text-[16px] text-indigo">•</span>
          <h2 className="m-0 font-display text-[30px] text-ink max-md:text-[24px]">{heading}</h2>
          {!isEdit && (
            <span className="rounded-[5px] bg-line px-2 py-[3px] font-data text-[10px] text-faint-3 uppercase tracking-[0.06em]">
              by hand
            </span>
          )}
        </div>
        <p className="mb-[22px] font-reader text-[15px] text-muted">
          {isEdit
            ? 'Adjust the details and save.'
            : "The same form Review fills in for you — here it's yours to write."}
        </p>

        <form onSubmit={submit}>
          <div className="rounded-[14px] border border-line bg-white px-6 pt-[22px] pb-6 shadow-[0_2px_12px_-8px_rgba(0,0,0,0.14)]">
            <FieldLabel htmlFor={titleId}>Title</FieldLabel>
            <input
              ref={titleRef}
              id={titleId}
              value={values.title}
              onChange={(e) => set('title', e.target.value)}
              placeholder="What needs doing?"
              className="mb-5 w-full rounded-[9px] border border-line-warm bg-panel px-[13px] py-[11px] font-reader text-[20px] text-ink placeholder:text-faint-3 focus:border-indigo focus:outline-none"
            />

            <FieldLabel>Status</FieldLabel>
            <div className="mb-5 flex flex-wrap gap-[7px]">
              {STATUS_CHIPS.map((c) => {
                const selected = values.status === c.value
                return (
                  <Chip key={c.value} selected={selected} onClick={() => set('status', c.value)}>
                    <span className={cn('font-data', !selected && c.glyphClass)}>{c.glyph}</span>
                    {c.label}
                  </Chip>
                )
              })}
            </div>

            <div className="mb-5 flex flex-wrap gap-8">
              <div>
                <FieldLabel>Due</FieldLabel>
                <div className="flex flex-wrap gap-[7px]">
                  {dueChipTargets().map((c) => (
                    <Chip
                      key={c.key}
                      selected={dueKey === c.key}
                      onClick={() => pickDue(c.key, c.ms)}
                    >
                      {c.label}
                    </Chip>
                  ))}
                </div>
              </div>
              <div>
                <FieldLabel>Priority</FieldLabel>
                <div className="flex flex-wrap gap-[7px]">
                  {PRIORITY_CHIPS.map((c) => (
                    <Chip
                      key={c.value}
                      selected={values.priority === c.value}
                      onClick={() => set('priority', c.value)}
                    >
                      {c.label}
                    </Chip>
                  ))}
                  <Chip selected={values.priority === null} onClick={() => set('priority', null)}>
                    None
                  </Chip>
                </div>
              </div>
            </div>

            <FieldLabel htmlFor={notesId}>Notes</FieldLabel>
            <textarea
              id={notesId}
              value={values.notes}
              onChange={(e) => set('notes', e.target.value)}
              placeholder="Anything else worth remembering?"
              rows={3}
              className="w-full resize-y rounded-[9px] border border-line-warm bg-panel px-[13px] py-[11px] font-ui text-[14px] text-ink leading-relaxed placeholder:text-faint-3 focus:border-indigo focus:outline-none"
            />
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
                  Delete this task?
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
              type="submit"
              disabled={!canSubmit}
              className="rounded-[23px] bg-indigo px-[22px] py-[11px] font-ui font-medium text-[14px] text-white transition-colors hover:bg-indigo-deep disabled:cursor-not-allowed disabled:bg-line-warm disabled:text-faint-3"
            >
              {submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
