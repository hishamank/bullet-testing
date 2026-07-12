'use client'

/**
 * One pending suggestion in the Review inbox. The checkbox stages it ("will apply"); ✕ rejects it;
 * for tasks, ✎ opens Due / Status chips.
 *
 * `suggestions.edit` is accept-with-modifications (§4.7): it validates, applies, and resolves the
 * suggestion in one atomic step. So the chips build a *local draft* and a single "Apply with
 * changes" button commits it — clicking individual chips never half-applies.
 *
 * Two checkboxes can mean opposite things across the app: an auto-applied row arrives checked
 * (unchecking is undo). Everything that reaches *this* inbox is pending, so here a check always
 * means "stage to apply".
 */

import { useState } from 'react'
import { dayKey, relativeDueTargets } from '@/lib/format'
import type { SuggestionPayload } from '@/lib/types'
import type { SuggestionRow as Row } from '@/lib/view-model'

const STATUS_CHIPS: { label: string; value: string }[] = [
  { label: 'To do', value: 'todo' },
  { label: 'In progress', value: 'in_progress' },
  { label: 'Done', value: 'done' },
]

/** The four Due chips: Today / Tomorrow / next Friday / None — resolved to epoch-ms (or null). */
function dueChipTargets(now = Date.now()): { label: string; ms: number | null }[] {
  const { today, tomorrow, friday } = relativeDueTargets(now)
  return [
    { label: 'Today', ms: today },
    { label: 'Tomorrow', ms: tomorrow },
    { label: 'Fri', ms: friday },
    { label: 'None', ms: null },
  ]
}

function Chip({
  label,
  selected,
  onClick,
}: {
  label: string
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border px-3 py-[5px] font-ui text-[12.5px] transition-colors ${
        selected
          ? 'border-indigo bg-indigo text-white'
          : 'border-line-cool bg-white text-muted-soft hover:border-indigo'
      }`}
    >
      {label}
    </button>
  )
}

export function SuggestionRow({
  row,
  payload,
  expanded,
  busy,
  onToggleStage,
  onDismiss,
  onToggleEdit,
  onApplyEdit,
}: {
  row: Row
  payload: SuggestionPayload
  expanded: boolean
  busy: boolean
  onToggleStage: () => void
  onDismiss: () => void
  onToggleEdit: () => void
  onApplyEdit: (payload: SuggestionPayload) => void
}) {
  const isTask = row.targetKind === 'task'
  const [dueDraft, setDueDraft] = useState<number | null>(
    typeof payload.due_at === 'number' ? payload.due_at : null,
  )
  const [statusDraft, setStatusDraft] = useState<string>(
    typeof payload.status === 'string' ? payload.status : 'todo',
  )

  return (
    <div className="flex items-start gap-3 py-[9px]">
      <button
        type="button"
        aria-pressed={row.staged}
        onClick={onToggleStage}
        disabled={busy}
        aria-label={`${row.label}: ${row.summary} — stage to apply`}
        className={`mt-[1px] flex h-5 w-5 flex-none items-center justify-center rounded-[6px] text-[12px] transition-colors disabled:opacity-50 ${
          row.staged
            ? 'border-none bg-indigo text-white'
            : 'border-[1.5px] border-faint-3 bg-white hover:border-indigo'
        }`}
      >
        {row.staged ? '✓' : ''}
      </button>

      <span className="mt-[1px] w-4 flex-none text-center font-data text-[15px] text-indigo">
        {row.glyph}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-[9px]">
          <span className="font-ui text-[14.5px] text-ink">
            <b className="font-semibold">{row.label}</b> — {row.summary}
          </span>
          <span className={`font-data text-[10.5px] tracking-[0.05em] ${row.tag.className}`}>
            {row.tag.text}
          </span>
        </div>

        {expanded && isTask && (
          <div className="mt-[10px] rounded-[10px] border border-line bg-panel px-[14px] py-[13px]">
            <div className="mb-[7px] font-data text-[10px] text-faint-2 uppercase tracking-[0.12em]">
              Due
            </div>
            <div className="mb-[13px] flex flex-wrap gap-[7px]">
              {dueChipTargets().map((c) => (
                <Chip
                  key={c.label}
                  label={c.label}
                  selected={
                    c.ms === null
                      ? dueDraft === null
                      : dueDraft != null && dayKey(c.ms) === dayKey(dueDraft)
                  }
                  onClick={() => setDueDraft(c.ms)}
                />
              ))}
            </div>
            <div className="mb-[7px] font-data text-[10px] text-faint-2 uppercase tracking-[0.12em]">
              Status
            </div>
            <div className="flex flex-wrap gap-[7px]">
              {STATUS_CHIPS.map((c) => (
                <Chip
                  key={c.value}
                  label={c.label}
                  selected={statusDraft === c.value}
                  onClick={() => setStatusDraft(c.value)}
                />
              ))}
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => onApplyEdit({ ...payload, due_at: dueDraft, status: statusDraft })}
              className="mt-[14px] rounded-[20px] bg-indigo px-[16px] py-[8px] font-ui font-medium text-[13px] text-white transition-colors hover:bg-indigo-deep disabled:opacity-50"
            >
              Apply with changes
            </button>
          </div>
        )}
      </div>

      {isTask && (
        <button
          type="button"
          onClick={onToggleEdit}
          aria-label="Edit due date and status"
          aria-expanded={expanded}
          title="Edit"
          className="flex-none px-[2px] text-[14px] text-faint-3 hover:text-indigo"
        >
          ✎
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        disabled={busy}
        aria-label="Dismiss suggestion"
        title="Dismiss"
        className="flex-none px-[2px] text-[15px] text-faint-3 hover:text-rust disabled:opacity-50"
      >
        ✕
      </button>
    </div>
  )
}
