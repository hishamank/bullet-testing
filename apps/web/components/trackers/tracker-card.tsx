'use client'

/**
 * One tracker in the grid: a name + type, a mini visualization matched to its input type
 * (line / heatmap / select-or-text value), the latest reading, and a one-tap Log button. The whole
 * card is a button into the detail view; Log opens the entry dialog without leaving the grid.
 *
 * Everything shown is shaped by `trackerCardVM` — this stays purely declarative.
 */

import type { TrackerCardVM } from '@/lib/trackers-view-model'

const OCHRE = 'var(--color-ochre)'

export function TrackerCard({
  vm,
  onOpen,
  onLog,
}: {
  vm: TrackerCardVM
  onOpen: () => void
  onLog: () => void
}) {
  return (
    <div className="flex flex-col rounded-[14px] border border-line bg-white px-[17px] pt-4 pb-[14px] shadow-[0_2px_12px_-9px_rgba(0,0,0,0.18)]">
      <button
        type="button"
        onClick={onOpen}
        className="mb-3 flex w-full items-center gap-[9px] text-left"
      >
        <span className="w-4 text-center font-data text-[16px] text-ochre">{vm.glyph}</span>
        <span className="truncate font-display text-[20px] text-ink leading-none">{vm.name}</span>
        <span className="flex-1" />
        <span className="font-data text-[9.5px] text-faint-3 uppercase tracking-[0.08em]">
          {vm.typeLabel}
        </span>
      </button>

      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${vm.name}`}
        className="mb-[11px] block h-[42px] w-full"
      >
        <MiniViz vm={vm} />
      </button>

      <div className="mb-[13px] flex items-baseline gap-[6px]">
        <span className="font-display text-[22px] text-ink leading-none">{vm.lastLabel}</span>
        {vm.lastWhen && <span className="font-data text-[10.5px] text-faint-2">{vm.lastWhen}</span>}
      </div>

      <div className="mt-auto flex items-center gap-[10px] border-line-soft border-t pt-3">
        <span className="min-w-0 flex-1 truncate font-data text-[10.5px] text-faint-2">
          {vm.todayNote}
        </span>
        <button
          type="button"
          onClick={onLog}
          className="inline-flex flex-none items-center gap-[6px] rounded-[20px] bg-ochre-wash px-[14px] py-2 font-ui font-medium text-[12.5px] text-ochre transition-[filter] hover:brightness-[0.96]"
        >
          <span className="font-data text-[13px]">+</span>
          {vm.logCta}
        </button>
      </div>
    </div>
  )
}

function MiniViz({ vm }: { vm: TrackerCardVM }) {
  if (!vm.hasData) {
    return (
      <div className="flex h-[42px] items-center font-data text-[11px] text-faint-3">
        nothing logged yet
      </div>
    )
  }
  if (vm.viz === 'line') {
    return (
      <svg
        viewBox="0 0 240 44"
        preserveAspectRatio="none"
        className="block h-[42px] w-full overflow-visible"
        role="img"
        aria-label={`${vm.name} recent trend`}
      >
        <polyline
          points={vm.sparkPoints}
          fill="none"
          stroke={OCHRE}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  if (vm.viz === 'heat') {
    return (
      <div className="flex h-[42px] items-center gap-[3px]" aria-hidden>
        {vm.heat.map((c) => (
          <span
            key={c.key}
            className={`h-[22px] flex-1 rounded-sm ${c.on ? 'bg-ochre' : 'bg-line-soft'}`}
          />
        ))}
      </div>
    )
  }
  // select / text — the value line already carries it; keep the tile calm.
  return (
    <div className="flex h-[42px] items-center font-reader text-[14.5px] text-muted italic">
      {vm.lastLabel === '—' ? '' : `“${vm.lastLabel}”`}
    </div>
  )
}
