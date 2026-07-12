'use client'

/**
 * A tracker's detail view — a header, a log bar, and a visualization matched to the input type:
 *  - scale   → a 30-day trend line + a year-in-pixels grid
 *  - number  → a trend line + total/average summary
 *  - boolean → current/longest streak + a six-month heatmap
 *  - select  → an option distribution
 *  - text    → (history only)
 * followed by the full entry history with per-entry provenance.
 *
 * The heavy roll-ups (`series` / `yearInPixels` / `streaks`) arrive pre-aggregated from
 * `trackerAnalytics`; this component only lays them out via the view-model. Purely declarative.
 */

import { EntryHistory } from '@/components/trackers/entry-history'
import { dayDate } from '@/lib/format'
import {
  INPUT_TYPE_META,
  latestEntry,
  logCta,
  numberSummary,
  selectDistribution,
  streakViz,
  todaySummary,
  trackerScale,
  trendViz,
  yearGrid,
} from '@/lib/trackers-view-model'
import type {
  BooleanStreaks,
  Bullet,
  DailyBucket,
  Tracker,
  TrackerEntry,
  YearInPixels,
} from '@/lib/types'

const OCHRE = 'var(--color-ochre)'

export interface DetailAnalytics {
  series?: DailyBucket[]
  yearInPixels?: YearInPixels
  streaks?: BooleanStreaks
  loading: boolean
}

export function TrackerDetail({
  tracker,
  entries,
  bulletsById,
  analytics,
  busy,
  onBack,
  onLog,
  onEdit,
  onDeleteEntry,
}: {
  tracker: Tracker
  entries: TrackerEntry[]
  bulletsById: Map<string, Bullet>
  analytics: DetailAnalytics
  busy: boolean
  onBack: () => void
  onLog: () => void
  onEdit: () => void
  onDeleteEntry: (id: string) => void
}) {
  const meta = INPUT_TYPE_META[tracker.input_type]
  const oldest = [...entries].sort((a, b) => a.logged_at - b.logged_at)[0]
  const latest = latestEntry(entries)

  return (
    <div className="px-10 pt-[30px] pb-14 max-md:px-5 max-md:pt-6">
      <div className="mx-auto max-w-[720px]">
        <button
          type="button"
          onClick={onBack}
          className="mb-4 inline-flex items-center gap-[6px] font-data text-[11px] text-faint-2 transition-colors hover:text-ochre"
        >
          ← all trackers
        </button>

        <div className="mb-4 flex items-start justify-between gap-6">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-[11px] bg-ochre-wash font-data text-[20px] text-ochre">
              {meta.glyph}
            </span>
            <div>
              <h2 className="m-0 font-display text-[30px] text-ink leading-none max-md:text-[25px]">
                {tracker.name}
              </h2>
              <div className="mt-[5px] font-data text-[11px] text-faint-2">
                {meta.label} · {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
                {oldest && ` · since ${dayDate(oldest.logged_at)}`}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onEdit}
            className="flex-none rounded-[20px] border border-line-warm px-[14px] py-2 font-ui text-[12.5px] text-muted-soft transition-colors hover:border-ochre hover:text-ochre"
          >
            Edit tracker
          </button>
        </div>

        {/* LOG BAR */}
        <div className="mb-6 flex items-center gap-4 rounded-[12px] border border-line bg-white px-[18px] py-[15px] shadow-[0_2px_12px_-9px_rgba(0,0,0,0.18)]">
          <div className="min-w-0 flex-1">
            <div className="font-data text-[10px] text-faint-2 uppercase tracking-[0.1em]">
              Today
            </div>
            <div className="mt-[2px] font-reader text-[16.5px] text-ink-deep">
              {todaySummary(entries, tracker)}
            </div>
          </div>
          <button
            type="button"
            onClick={onLog}
            className="inline-flex flex-none items-center gap-2 rounded-[24px] bg-ochre px-[22px] py-3 font-ui font-medium text-[14px] text-white transition-colors hover:bg-ochre-deep"
          >
            <span className="font-data text-[15px]">+</span>
            {logCta(tracker)}
          </button>
        </div>

        <Viz tracker={tracker} entries={entries} analytics={analytics} latest={latest} />

        <EntryHistory
          entries={entries}
          tracker={tracker}
          bulletsById={bulletsById}
          busy={busy}
          onDelete={onDeleteEntry}
          heading={
            tracker.input_type === 'text' || meta.viz === 'select' ? 'History' : 'All entries'
          }
        />
      </div>
    </div>
  )
}

// --- per-type visualizations ----------------------------------------------------------------

function Viz({
  tracker,
  entries,
  analytics,
  latest,
}: {
  tracker: Tracker
  entries: TrackerEntry[]
  analytics: DetailAnalytics
  latest?: TrackerEntry
}) {
  const cfg = tracker.config
  if (
    analytics.loading &&
    (cfg.input_type === 'scale' || cfg.input_type === 'number' || cfg.input_type === 'boolean')
  ) {
    return <VizSkeleton />
  }
  if (cfg.input_type === 'scale') {
    return (
      <ScaleViz tracker={tracker} series={analytics.series ?? []} year={analytics.yearInPixels} />
    )
  }
  if (cfg.input_type === 'number') {
    return <NumberViz series={analytics.series ?? []} />
  }
  if (cfg.input_type === 'boolean') {
    return <BooleanViz streaks={analytics.streaks} />
  }
  if (cfg.input_type === 'single_select' || cfg.input_type === 'multi_select') {
    return <SelectViz tracker={tracker} entries={entries} />
  }
  return latest ? null : <EmptyViz />
}

function VizSkeleton() {
  return (
    <div
      className="h-[140px] animate-pulse rounded-[12px] border border-line bg-white"
      aria-hidden
    />
  )
}

function EmptyViz() {
  return (
    <div className="rounded-[12px] border border-line border-dashed bg-panel px-5 py-8 text-center font-ui text-[13px] text-faint">
      Log an entry to start the history.
    </div>
  )
}

function SectionCaption({ left, right }: { left: string; right?: React.ReactNode }) {
  return (
    <div className="mb-[10px] flex items-baseline justify-between">
      <span className="font-data text-[10.5px] text-faint-2 uppercase tracking-[0.12em]">
        {left}
      </span>
      {right}
    </div>
  )
}

function TrendChart({ series, min, max }: { series: DailyBucket[]; min?: number; max?: number }) {
  const v = trendViz(series, { min, max })
  if (!v.hasData) return <EmptyViz />
  return (
    <div className="rounded-[12px] border border-line bg-white px-[18px] pt-4 pb-3">
      <svg
        viewBox="0 0 640 120"
        preserveAspectRatio="none"
        className="block h-[120px] w-full overflow-visible"
        role="img"
        aria-label="Trend over recent days"
      >
        <title>Trend over recent days</title>
        {v.gridLines.map((y) => (
          <line
            key={y}
            x1="0"
            y1={y}
            x2="640"
            y2={y}
            stroke="var(--color-line-soft)"
            strokeWidth={1}
          />
        ))}
        <polyline
          points={v.points}
          fill="none"
          stroke={OCHRE}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {v.dots.map((d) => (
          <circle key={`${d.x}-${d.y}`} cx={d.x} cy={d.y} r={2.4} fill={OCHRE} />
        ))}
      </svg>
    </div>
  )
}

function ScaleViz({
  tracker,
  series,
  year,
}: {
  tracker: Tracker
  series: DailyBucket[]
  year?: YearInPixels
}) {
  const scale = trackerScale(tracker)
  const v = trendViz(series, scale ? { min: scale.min, max: scale.max } : {})
  return (
    <div>
      <SectionCaption
        left="Last 30 days"
        right={
          v.hasData ? (
            <span className="font-ui text-[13px] text-muted">
              avg <b className="font-semibold text-ink">{v.recentAvg}</b>
              {v.priorAvg && ` · was ${v.priorAvg}`}
            </span>
          ) : undefined
        }
      />
      <div className="mb-7">
        <TrendChart series={series} min={scale?.min} max={scale?.max} />
      </div>
      {year && year.days.length > 0 && <YearInPixelsGrid year={year} />}
    </div>
  )
}

function YearInPixelsGrid({ year }: { year: YearInPixels }) {
  const grid = yearGrid(year)
  return (
    <div>
      <SectionCaption
        left={`${year.year} · a year in pixels`}
        right={
          <div className="flex items-center gap-2">
            <span className="font-data text-[10px] text-faint-3">low</span>
            {grid.legend.map((bg, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed 5-step legend swatches
                key={i}
                className="h-4 w-4 rounded-[3px]"
                style={{ background: bg }}
              />
            ))}
            <span className="font-data text-[10px] text-faint-3">great</span>
          </div>
        }
      />
      <div className="overflow-x-auto rounded-[12px] border border-line bg-white px-[18px] py-4">
        <div className="min-w-[520px]">
          {grid.rows.map((row) => (
            <div key={row.name} className="mb-1 flex items-center gap-2">
              <span className="w-[26px] flex-none text-right font-data text-[10px] text-faint-2">
                {row.name}
              </span>
              <div className="grid flex-1 grid-cols-[repeat(31,1fr)] gap-[3px]">
                {row.cells.map((cell, i) =>
                  cell.real ? (
                    <span
                      // biome-ignore lint/suspicious/noArrayIndexKey: fixed calendar grid position
                      key={i}
                      title={cell.title}
                      className="aspect-square rounded-[2.5px]"
                      style={{ background: cell.bg }}
                    />
                  ) : (
                    // biome-ignore lint/suspicious/noArrayIndexKey: fixed calendar grid position
                    <span key={i} />
                  ),
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function NumberViz({ series }: { series: DailyBucket[] }) {
  const s = numberSummary(series)
  return (
    <div>
      <SectionCaption
        left="Recent trend"
        right={
          s.count > 0 ? (
            <span className="flex gap-5 font-ui text-[13px] text-muted">
              <span>
                avg <b className="font-semibold text-ink">{s.avg}</b>
              </span>
              <span>
                total <b className="font-semibold text-ink">{s.total}</b>
              </span>
            </span>
          ) : undefined
        }
      />
      <TrendChart series={series} />
    </div>
  )
}

function BooleanViz({ streaks }: { streaks?: BooleanStreaks }) {
  if (!streaks) return <VizSkeleton />
  const v = streakViz(streaks)
  return (
    <div>
      <div className="mb-6 grid grid-cols-3 gap-4 max-md:grid-cols-1">
        <StatCard label="Current streak" value={v.current} unit="days" accent />
        <StatCard label="Longest" value={v.longest} unit="days" />
        <StatCard label="This month" value={v.monthOnDays} unit={`of ${v.monthElapsed}`} />
      </div>
      <SectionCaption left="Last six months" />
      <div className="overflow-x-auto rounded-[12px] border border-line bg-white px-5 py-[18px]">
        <div className="flex items-start gap-1">
          <div className="mr-1 flex flex-col gap-[3px]">
            {v.dayLabels.map((d, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed 7 weekday rows
                key={i}
                className="h-[14px] font-data text-[9px] text-faint-3 leading-[14px]"
              >
                {i % 2 === 1 ? d : ''}
              </span>
            ))}
          </div>
          {v.columns.map((col, ci) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed week columns
              key={ci}
              className="flex flex-col gap-[3px]"
            >
              {col.cells.map((cell, ri) =>
                cell.real ? (
                  <span
                    // biome-ignore lint/suspicious/noArrayIndexKey: fixed day-of-week cell
                    key={ri}
                    title={cell.title}
                    className={`h-[14px] w-[14px] rounded-[3px] ${cell.on ? 'bg-ochre' : 'bg-line-soft'}`}
                  />
                ) : (
                  // biome-ignore lint/suspicious/noArrayIndexKey: fixed day-of-week cell
                  <span key={ri} className="h-[14px] w-[14px]" />
                ),
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function StatCard({
  label,
  value,
  unit,
  accent,
}: {
  label: string
  value: number
  unit: string
  accent?: boolean
}) {
  return (
    <div className="rounded-[12px] border border-line bg-white px-[18px] py-4">
      <div className="font-data text-[10px] text-faint-2 uppercase tracking-[0.1em]">{label}</div>
      <div className="mt-2 flex items-baseline gap-[6px]">
        <span
          className={`font-display text-[34px] leading-none ${accent ? 'text-ochre' : 'text-ink'}`}
        >
          {value}
        </span>
        <span className="font-data text-[12px] text-faint-2">{unit}</span>
      </div>
    </div>
  )
}

function SelectViz({ tracker, entries }: { tracker: Tracker; entries: TrackerEntry[] }) {
  const dist = selectDistribution(entries, tracker)
  if (dist.length === 0) return <EmptyViz />
  return (
    <div className="flex flex-wrap gap-2">
      {dist.map((d) => (
        <div
          key={d.label}
          className="min-w-[120px] flex-1 rounded-[10px] border border-line bg-white px-[13px] py-3"
        >
          <div className="mb-2 flex items-center gap-[7px]">
            <span className="h-[9px] w-[9px] rounded-full bg-ochre" />
            <span className="font-ui text-[12.5px] text-muted-soft">{d.label}</span>
          </div>
          <div className="font-display text-[22px] text-ink leading-none">{d.pct}</div>
          <div className="mt-1 font-data text-[10px] text-faint-3">
            {d.count} {d.count === 1 ? 'time' : 'times'}
          </div>
        </div>
      ))}
    </div>
  )
}
