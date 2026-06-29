'use client'

/**
 * The Payoff · Timeline — your journal by day. Each day weaves the bullets you wrote together with
 * everything the agent pulled from them (entity chips under each bullet). Tap a day to open it.
 * Reads the bullet stream and the provenance-grouped entities from the live tRPC lists.
 */

import { useMemo, useState } from 'react'
import { EmptyState } from '@/components/empty-state'
import { dayDate, dayKey, dayName, formatTime, relBadge } from '@/lib/format'
import { useJournalData } from '@/lib/use-journal-data'
import { bulletGlyph, groupBy, type NormalizedEntity } from '@/lib/view-model'

interface SummaryChip {
  glyph: string
  colorClass: string
  text: string
}

function summarize(entities: NormalizedEntity[]): SummaryChip[] {
  let task = 0
  let activity = 0
  let tracker = 0
  for (const e of entities) {
    if (e.kind === 'task') task++
    else if (e.kind === 'activity') activity++
    else tracker++
  }
  const out: SummaryChip[] = []
  if (task > 0)
    out.push({
      glyph: '•',
      colorClass: 'text-indigo',
      text: `${task} ${task === 1 ? 'task' : 'tasks'}`,
    })
  if (activity > 0)
    out.push({
      glyph: '○',
      colorClass: 'text-indigo',
      text: `${activity} ${activity === 1 ? 'activity' : 'activities'}`,
    })
  if (tracker > 0)
    out.push({
      glyph: '—',
      colorClass: 'text-ochre',
      text: `${tracker} ${tracker === 1 ? 'tracker' : 'trackers'}`,
    })
  return out
}

export default function TimelinePage() {
  const { bullets, entitiesByBulletId, isError, isLoading } = useJournalData()
  const [openOverride, setOpenOverride] = useState<Set<string> | null>(null)

  const days = useMemo(() => {
    const byDay = groupBy(bullets, (b) => dayKey(b.created_at))
    return [...byDay.entries()]
      .map(([key, dayBullets]) => {
        const sorted = [...dayBullets].sort((a, b) => a.created_at - b.created_at)
        const ts = sorted[0]?.created_at ?? 0
        const dayEntities = sorted.flatMap((b) => entitiesByBulletId.get(b.id) ?? [])
        return {
          key,
          ts,
          name: dayName(ts),
          rel: relBadge(ts),
          date: dayDate(ts),
          bullets: sorted,
          summary: summarize(dayEntities),
        }
      })
      .sort((a, b) => b.ts - a.ts)
  }, [bullets, entitiesByBulletId])

  // Default: the two most recent days open, until the user starts toggling.
  const defaultOpen = useMemo(() => new Set(days.slice(0, 2).map((d) => d.key)), [days])
  const openSet = openOverride ?? defaultOpen

  function toggle(key: string) {
    setOpenOverride((prev) => {
      const base = prev ?? defaultOpen
      const next = new Set(base)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  if (isError) {
    return (
      <EmptyState
        glyphs="•  ○  —"
        title="The journal server is asleep."
        body="Couldn't reach the local server on :3001. Start it, then your days weave together here."
      />
    )
  }

  return (
    <div className="px-10 pt-[34px] pb-12 max-md:px-5 max-md:pt-6">
      <div className="mx-auto max-w-[880px]">
        <div className="font-data text-[11px] text-faint-2 uppercase tracking-[0.14em]">
          Your journal, by day
        </div>
        <h2 className="mt-[6px] mb-1 font-display text-[34px] text-ink max-md:text-[28px]">
          Timeline
        </h2>
        <p className="mb-[14px] max-w-[540px] font-reader text-[16px] text-muted leading-relaxed">
          Each day, your bullets and everything the agent pulled from them — woven back together.
          Tap a day to open it.
        </p>

        {bullets.length === 0 && !isLoading ? (
          <EmptyState
            glyphs="•  ○  —"
            title="Your timeline is empty."
            body="Start in the Stream — each day's bullets, and everything pulled from them, will gather here."
            className="h-[50vh]"
          />
        ) : (
          days.map((d) => {
            const open = openSet.has(d.key)
            return (
              <div key={d.key} className="border-line border-t py-5">
                <button
                  type="button"
                  onClick={() => toggle(d.key)}
                  aria-expanded={open}
                  aria-label={`${d.name}, ${d.date} — ${open ? 'collapse' : 'expand'}`}
                  className="flex w-full items-center justify-between gap-[18px] text-left"
                >
                  <span className="flex flex-none items-baseline gap-[11px]">
                    <span className="font-display text-[24px] text-ink">{d.name}</span>
                    {d.rel && (
                      <span className="rounded-[5px] bg-indigo-wash px-[7px] py-[2px] font-data text-[10px] text-indigo uppercase tracking-[0.1em]">
                        {d.rel}
                      </span>
                    )}
                    <span className="font-data text-[12px] text-faint-3">{d.date}</span>
                  </span>
                  <span className="flex min-w-0 items-center gap-4">
                    <span className="flex flex-wrap justify-end gap-[15px] max-md:hidden">
                      {d.summary.map((p) => (
                        <span
                          key={p.text}
                          className="inline-flex items-baseline gap-[6px] whitespace-nowrap font-ui text-[13px] text-muted"
                        >
                          <span className={`font-data ${p.colorClass}`}>{p.glyph}</span>
                          {p.text}
                        </span>
                      ))}
                    </span>
                    <span className="w-3 flex-none font-data text-[12px] text-faint-3">
                      {open ? '▾' : '▸'}
                    </span>
                  </span>
                </button>

                {open && (
                  <div className="mt-4">
                    {d.bullets.map((b) => {
                      const entities = entitiesByBulletId.get(b.id) ?? []
                      const g = bulletGlyph(entities)
                      return (
                        <div
                          key={b.id}
                          className="grid grid-cols-[62px_1fr] gap-x-[22px] py-[9px] max-md:grid-cols-[40px_1fr] max-md:gap-x-3"
                        >
                          <div className="pt-[6px] text-right font-data text-[11px] text-faint-2">
                            {formatTime(b.created_at)}
                          </div>
                          <div className="border-line border-l pl-[22px] max-md:pl-4">
                            <div className="flex items-baseline gap-0">
                              <span
                                className={`-ml-[24px] w-[24px] flex-none bg-paper text-center font-data text-[15px] max-md:-ml-4 max-md:w-4 ${g.colorClass}`}
                              >
                                {g.glyph}
                              </span>
                              <span className="font-reader text-[18px] text-ink leading-relaxed max-md:text-[16px]">
                                {b.text}
                              </span>
                            </div>
                            {entities.length > 0 && (
                              <div className="mt-[9px] flex flex-wrap gap-[7px]">
                                {entities.map((e) => (
                                  <span
                                    key={e.id}
                                    className="inline-flex items-center gap-[6px] whitespace-nowrap rounded-lg border border-line bg-white px-[10px] py-[3px] font-ui text-[12px] text-muted-soft"
                                  >
                                    <span className={`font-data ${e.glyphColorClass}`}>
                                      {e.glyph}
                                    </span>
                                    {e.label}
                                    {e.detail ? ` · ${e.detail}` : ''}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
