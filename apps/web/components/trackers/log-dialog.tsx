'use client'

/**
 * The log dialog — manual entry logging matched to a tracker's schema: a scale picks a point on its
 * range, a number takes a value, a yes/no toggles, a select offers its options, text takes a line.
 * A controlled local draft; the page owns persistence (`trackerEntries.create`).
 */

import { useEffect, useId, useRef, useState } from 'react'
import {
  canLogValue,
  initialLogValue,
  type LogValue,
  trackerOptions,
  trackerScale,
  trackerUnit,
} from '@/lib/trackers-view-model'
import type { Tracker } from '@/lib/types'
import { cn } from '@/lib/utils'

export function LogDialog({
  tracker,
  busy,
  notice,
  onSubmit,
  onClose,
}: {
  tracker: Tracker
  busy: boolean
  notice?: string | null
  onSubmit: (value: LogValue) => void
  onClose: () => void
}) {
  const [value, setValue] = useState<LogValue>(() => initialLogValue(tracker))
  const titleId = useId()
  const firstRef = useRef<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>(null)

  useEffect(() => {
    firstRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const canSubmit = canLogValue(tracker, value) && !busy

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 max-md:items-end md:items-center">
      {/* A real button backdrop — click or Enter/Space dismisses, keyboard-reachable and announced. */}
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-ink/25"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative w-full max-w-[420px] rounded-[16px] border border-line bg-white p-6 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.45)]"
      >
        <div className="mb-1 flex items-center gap-[9px]">
          <span className="font-data text-[15px] text-ochre">—</span>
          <h2 id={titleId} className="m-0 font-display text-[22px] text-ink">
            Log {tracker.name}
          </h2>
        </div>
        <p className="mb-5 font-reader text-[14px] text-muted">A quick reading, dated now.</p>

        <ValueInput tracker={tracker} value={value} onChange={setValue} firstRef={firstRef} />

        {notice && (
          <p className="mt-3 font-ui text-[12.5px] text-rust" role="alert">
            {notice}
          </p>
        )}

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-2 py-[9px] font-ui text-[14px] text-faint transition-colors hover:text-muted-soft"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => onSubmit(value)}
            className="rounded-[22px] bg-ochre px-[20px] py-[10px] font-ui font-medium text-[14px] text-white transition-colors hover:bg-ochre-deep disabled:cursor-not-allowed disabled:bg-line-warm disabled:text-faint-3"
          >
            Log it
          </button>
        </div>
      </div>
    </div>
  )
}

function ValueInput({
  tracker,
  value,
  onChange,
  firstRef,
}: {
  tracker: Tracker
  value: LogValue
  onChange: (v: LogValue) => void
  firstRef: React.Ref<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>
}) {
  const cfg = tracker.config

  if (cfg.input_type === 'scale') {
    const scale = trackerScale(tracker)
    if (!scale) return null
    const points = range(scale.min, scale.max)
    return (
      <div>
        <fieldset className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0" aria-label="Rating">
          {points.map((n, i) => (
            <button
              key={n}
              ref={i === 0 ? (firstRef as React.Ref<HTMLButtonElement>) : undefined}
              type="button"
              aria-pressed={value === n}
              onClick={() => onChange(n)}
              className={cn(
                'h-11 w-11 rounded-[10px] border font-data text-[15px] transition-colors',
                value === n
                  ? 'border-ochre bg-ochre text-white'
                  : 'border-line-warm bg-panel text-muted hover:border-ochre',
              )}
            >
              {n}
            </button>
          ))}
        </fieldset>
        {scale.labels && (scale.labels[0] || scale.labels[1]) && (
          <div className="mt-2 flex justify-between font-ui text-[11.5px] text-faint-2">
            <span>{scale.labels[0]}</span>
            <span>{scale.labels[1]}</span>
          </div>
        )}
      </div>
    )
  }

  if (cfg.input_type === 'number') {
    const unit = trackerUnit(tracker)
    return (
      <div className="flex items-center gap-2">
        <input
          ref={firstRef as React.Ref<HTMLInputElement>}
          type="number"
          inputMode="decimal"
          value={typeof value === 'number' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))}
          className="w-40 rounded-[9px] border border-line-warm bg-panel px-[13px] py-[11px] font-data text-[18px] text-ink focus:border-ochre focus:outline-none"
        />
        {unit && <span className="font-ui text-[14px] text-muted">{unit}</span>}
      </div>
    )
  }

  if (cfg.input_type === 'boolean') {
    return (
      <fieldset className="m-0 flex min-w-0 gap-2 border-0 p-0" aria-label="Yes or no">
        {[true, false].map((b, i) => (
          <button
            key={String(b)}
            ref={i === 0 ? (firstRef as React.Ref<HTMLButtonElement>) : undefined}
            type="button"
            aria-pressed={value === b}
            onClick={() => onChange(b)}
            className={cn(
              'flex-1 rounded-[10px] border py-3 font-ui font-medium text-[14px] transition-colors',
              value === b
                ? 'border-ochre bg-ochre text-white'
                : 'border-line-warm bg-panel text-muted hover:border-ochre',
            )}
          >
            {b ? 'Yes' : 'No'}
          </button>
        ))}
      </fieldset>
    )
  }

  if (cfg.input_type === 'single_select') {
    return (
      <fieldset className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0" aria-label="Choose one">
        {trackerOptions(tracker).map((opt, i) => (
          <button
            key={opt}
            ref={i === 0 ? (firstRef as React.Ref<HTMLButtonElement>) : undefined}
            type="button"
            aria-pressed={value === opt}
            onClick={() => onChange(opt)}
            className={cn(
              'rounded-[10px] border px-[14px] py-[9px] font-ui text-[13.5px] transition-colors',
              value === opt
                ? 'border-ochre bg-ochre text-white'
                : 'border-line-warm bg-panel text-muted hover:border-ochre',
            )}
          >
            {opt}
          </button>
        ))}
      </fieldset>
    )
  }

  if (cfg.input_type === 'multi_select') {
    const picked = Array.isArray(value) ? value : []
    return (
      <fieldset className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0" aria-label="Choose any">
        {trackerOptions(tracker).map((opt, i) => {
          const on = picked.includes(opt)
          return (
            <button
              key={opt}
              ref={i === 0 ? (firstRef as React.Ref<HTMLButtonElement>) : undefined}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(on ? picked.filter((p) => p !== opt) : [...picked, opt])}
              className={cn(
                'rounded-[10px] border px-[14px] py-[9px] font-ui text-[13.5px] transition-colors',
                on
                  ? 'border-ochre bg-ochre text-white'
                  : 'border-line-warm bg-panel text-muted hover:border-ochre',
              )}
            >
              {opt}
            </button>
          )
        })}
      </fieldset>
    )
  }

  // text
  return (
    <textarea
      ref={firstRef as React.Ref<HTMLTextAreaElement>}
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange(e.target.value)}
      rows={3}
      placeholder="What do you want to note?"
      className="w-full resize-y rounded-[9px] border border-line-warm bg-panel px-[13px] py-[11px] font-reader text-[16px] text-ink leading-relaxed placeholder:text-faint-3 focus:border-ochre focus:outline-none"
    />
  )
}

function range(min: number, max: number): number[] {
  const out: number[] = []
  for (let n = min; n <= max; n++) out.push(n)
  return out
}
