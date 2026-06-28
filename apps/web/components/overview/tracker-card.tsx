'use client'

/**
 * A "This week" tracker card. The visualization is matched to the tracker's input type:
 *  - number / scale  → an average value + a sparkline of the recent series
 *  - boolean         → a trailing streak + on/off dots
 *  - select / text   → the latest value
 *
 * Computed entirely from the tracker's logged entries (read-only); empty trackers say so quietly.
 */

import type { Tracker, TrackerEntry } from '@/lib/types'

const VB_W = 200
const VB_H = 40

function sparkline(values: number[]): string {
  if (values.length === 0) return ''
  if (values.length === 1) return `4,${VB_H / 2} ${VB_W - 4},${VB_H / 2}`
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const p = 4
  return values
    .map((v, i) => {
      const x = p + (i / (values.length - 1)) * (VB_W - 2 * p)
      const y = VB_H - p - ((v - min) / range) * (VB_H - 2 * p)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

const round1 = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

export function TrackerCard({ tracker, entries }: { tracker: Tracker; entries: TrackerEntry[] }) {
  const recent = entries.slice(-14)
  const isNumeric = tracker.input_type === 'number' || tracker.input_type === 'scale'
  const isBoolean = tracker.input_type === 'boolean'

  let value = '—'
  let unit = ''
  let trend = '○'
  let note = 'no entries yet'
  let viz: React.ReactNode = null

  if (recent.length === 0) {
    // leave the calm empty defaults
  } else if (isNumeric) {
    const nums = recent.map((e) => Number(e.value)).filter(Number.isFinite)
    if (nums.length > 0) {
      value = round1(avg(nums))
      // `config` is a discriminated union on `input_type` — narrow on the discriminant (no cast).
      const cfg = tracker.config
      unit =
        cfg.input_type === 'scale'
          ? `/ ${cfg.max}`
          : cfg.input_type === 'number'
            ? (cfg.unit ?? '')
            : ''
      const half = Math.floor(nums.length / 2)
      if (nums.length >= 2)
        trend = avg(nums.slice(half)) >= avg(nums.slice(0, half || 1)) ? '↑' : '↓'
      note = `${nums.length} logged this week`
      viz = (
        <svg
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          preserveAspectRatio="none"
          className="block h-[38px] w-full overflow-visible"
          role="img"
          aria-label={`${tracker.name} recent trend`}
        >
          <polyline
            points={sparkline(nums)}
            fill="none"
            stroke="#3e4d6b"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )
    }
  } else if (isBoolean) {
    const bools = recent.map((e) => Boolean(e.value))
    let streak = 0
    for (let i = bools.length - 1; i >= 0 && bools[i]; i--) streak++
    value = `${streak}-day`
    unit = 'streak'
    trend = '○'
    note = `${bools.filter(Boolean).length} of last ${bools.length}`
    const slots = bools.slice(-14)
    viz = (
      <div className="flex h-[38px] items-end gap-[3px] pb-2">
        {slots.map((on, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed positional dots
            key={i}
            className={`h-[11px] flex-1 rounded-sm ${on ? 'bg-sage' : 'bg-line-warm'}`}
          />
        ))}
      </div>
    )
  } else {
    const last = recent[recent.length - 1]
    value = last ? String(last.value) : '—'
    note = `${recent.length} logged`
  }

  return (
    <div className="rounded-xl border border-line bg-white px-4 pt-[15px] pb-[13px] shadow-[0_2px_12px_-9px_rgba(0,0,0,0.18)]">
      <div className="flex items-baseline justify-between">
        <span className="truncate font-data text-[10.5px] text-faint-2 uppercase tracking-[0.1em]">
          {tracker.name}
        </span>
        <span className="font-data text-[12px] text-sage">{trend}</span>
      </div>
      <div className="mt-[7px] mb-[11px] flex items-baseline gap-[5px]">
        <span className="font-display text-[28px] text-ink leading-none">{value}</span>
        {unit && <span className="font-data text-[11px] text-faint-3">{unit}</span>}
      </div>
      <div className="h-[38px]">{viz}</div>
      <div className="mt-[9px] font-data text-[10px] text-faint">{note}</div>
    </div>
  )
}
