'use client'

/**
 * The Payoff · Overview — where the journaling becomes a calm glance. Greeting + review nudge,
 * "This week" tracker cards, and two columns (Today's tasks / Recently logged) where every item
 * keeps a thread back to the bullet that created it. All read from the live tRPC lists.
 */

import Link from 'next/link'
import { useMemo } from 'react'
import { EmptyState } from '@/components/empty-state'
import { Provenance } from '@/components/overview/provenance'
import { TrackerCard } from '@/components/overview/tracker-card'
import { statusPill, taskGlyph } from '@/lib/design'
import { daysAgo, dueLabel, formatTime, fullDateLine, greeting, shortDay } from '@/lib/format'
import { useJournalData } from '@/lib/use-journal-data'
import { groupBy, normalizeActivity, normalizeTrackerEntry } from '@/lib/view-model'

export default function OverviewPage() {
  const {
    tasks,
    trackers,
    trackerEntries,
    activities,
    suggestions,
    bulletsById,
    trackersById,
    isError,
    isLoading,
  } = useJournalData()

  const pendingCount = suggestions.length

  const entriesByTracker = useMemo(
    () => groupBy(trackerEntries, (e) => e.tracker_id),
    [trackerEntries],
  )

  const weekTrackers = useMemo(
    () =>
      [...trackers]
        .sort(
          (a, b) =>
            (entriesByTracker.get(b.id)?.length ?? 0) - (entriesByTracker.get(a.id)?.length ?? 0),
        )
        .slice(0, 4),
    [trackers, entriesByTracker],
  )

  const todayTasks = useMemo(
    () =>
      tasks
        .filter((t) => t.status !== 'cancelled')
        .sort((a, b) => {
          const ad = a.status === 'done' ? 1 : 0
          const bd = b.status === 'done' ? 1 : 0
          if (ad !== bd) return ad - bd
          return (a.due_at ?? Number.POSITIVE_INFINITY) - (b.due_at ?? Number.POSITIVE_INFINITY)
        })
        .slice(0, 6),
    [tasks],
  )
  const openTaskCount = tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled').length

  const recent = useMemo(
    () =>
      [
        ...activities.map(normalizeActivity),
        ...trackerEntries.map((e) => normalizeTrackerEntry(e, trackersById)),
      ]
        .sort((a, b) => b.at - a.at)
        .slice(0, 6),
    [activities, trackerEntries, trackersById],
  )

  const empty =
    !isLoading &&
    tasks.length === 0 &&
    trackers.length === 0 &&
    activities.length === 0 &&
    trackerEntries.length === 0

  const subline = (() => {
    if (empty)
      return 'Your journal is just getting started — head to the Stream and empty your head.'
    const parts: string[] = []
    if (openTaskCount > 0)
      parts.push(`${openTaskCount} open ${openTaskCount === 1 ? 'task' : 'tasks'}`)
    const loggedToday =
      trackerEntries.filter((e) => daysAgo(e.logged_at) === 0).length +
      activities.filter((a) => daysAgo(a.occurred_at) === 0).length
    if (loggedToday > 0) parts.push(`${loggedToday} logged today`)
    return parts.length > 0 ? `${parts.join(' · ')}.` : 'A calm day so far.'
  })()

  if (isError) {
    return (
      <EmptyState
        glyphs="◆  ≡  ○"
        title="The journal server is asleep."
        body="Couldn't reach the local server on :3001. Start it, then your week surfaces here."
      />
    )
  }

  return (
    <div className="px-10 pt-[34px] pb-12 max-md:px-5 max-md:pt-6">
      <div className="mx-auto max-w-[940px]">
        <div className="font-data text-[11px] text-faint-2 uppercase tracking-[0.14em]">
          {fullDateLine()}
        </div>
        <h2 className="mt-[6px] font-display text-[34px] text-ink max-md:text-[28px]">
          {greeting()}.
        </h2>
        <p className="mt-[14px] mb-[26px] max-w-[560px] font-reader text-[17px] text-muted leading-relaxed">
          {subline}
        </p>

        {pendingCount > 0 && (
          <Link
            href="/review"
            className="mb-[30px] flex items-center justify-between rounded-xl border border-indigo-line bg-indigo-wash px-[18px] py-[14px] transition-colors hover:border-indigo"
          >
            <span className="flex items-center gap-[13px]">
              <span className="inline-flex h-[30px] w-[30px] items-center justify-center rounded-full bg-indigo font-data text-[13px] text-white">
                {pendingCount}
              </span>
              <span className="font-ui text-[14.5px] text-indigo-deep">
                {pendingCount === 1 ? 'suggestion' : 'suggestions'} waiting in your Review inbox
              </span>
            </span>
            <span className="font-ui text-[13.5px] text-indigo">Open →</span>
          </Link>
        )}

        {weekTrackers.length > 0 && (
          <>
            <div className="mb-3 font-data text-[10.5px] text-faint-2 uppercase tracking-[0.14em]">
              This week
            </div>
            <div className="mb-[34px] grid grid-cols-2 gap-4 md:grid-cols-4">
              {weekTrackers.map((t) => (
                <TrackerCard
                  key={t.id}
                  tracker={t}
                  entries={(entriesByTracker.get(t.id) ?? [])
                    .slice()
                    .sort((a, b) => a.logged_at - b.logged_at)}
                />
              ))}
            </div>
          </>
        )}

        <div className="grid grid-cols-1 gap-10 md:grid-cols-[1.08fr_1fr]">
          {/* Today */}
          <div>
            <div className="mb-1 flex items-baseline justify-between">
              <span className="font-display text-[22px] text-ink">Today</span>
              <span className="font-data text-[11px] text-faint-2">{openTaskCount} open</span>
            </div>
            {todayTasks.length === 0 ? (
              <p className="border-line-soft border-t py-[13px] font-reader text-[16px] text-faint italic">
                Nothing on your plate — enjoy the quiet.
              </p>
            ) : (
              todayTasks.map((t) => {
                const g = taskGlyph(t.status)
                const pill = statusPill(t.status)
                const bullet = t.source_bullet_id ? bulletsById.get(t.source_bullet_id) : undefined
                return (
                  <div key={t.id} className="flex gap-3 border-line-soft border-t py-[13px]">
                    <span
                      className={`mt-[3px] w-[15px] flex-none text-center font-data text-[15px] ${g.colorClass}`}
                    >
                      {g.glyph}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-[9px]">
                        <span
                          className={`font-reader text-[17px] ${t.status === 'done' ? 'text-faint-2 line-through' : 'text-ink'}`}
                        >
                          {t.title}
                        </span>
                        <span
                          className={`rounded-[5px] px-[7px] py-[2px] font-data text-[10px] uppercase tracking-[0.04em] ${pill.textClass} ${pill.bgClass}`}
                        >
                          {pill.text}
                        </span>
                        {t.due_at != null && (
                          <span className="font-data text-[11px] text-faint">
                            due {dueLabel(t.due_at)}
                          </span>
                        )}
                      </div>
                      <Provenance bullet={bullet} />
                    </div>
                  </div>
                )
              })
            )}
          </div>

          {/* Recently logged */}
          <div>
            <div className="mb-1 font-display text-[22px] text-ink">Recently logged</div>
            {recent.length === 0 ? (
              <p className="border-line-soft border-t py-[13px] font-reader text-[16px] text-faint italic">
                Nothing logged yet.
              </p>
            ) : (
              recent.map((e) => {
                const bullet = e.sourceBulletId ? bulletsById.get(e.sourceBulletId) : undefined
                return (
                  <div key={e.id} className="flex gap-3 border-line-soft border-t py-[13px]">
                    <span
                      className={`mt-[2px] w-[15px] flex-none text-center font-data text-[15px] ${e.glyphColorClass}`}
                    >
                      {e.glyph}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-[9px]">
                        <span className="font-ui text-[14.5px] text-ink">
                          <b className="font-semibold">{e.label}</b>
                          {e.detail ? ` · ${e.detail}` : ''}
                        </span>
                        <span className="font-data text-[11px] text-faint">
                          {shortDay(e.at)} {formatTime(e.at)}
                        </span>
                      </div>
                      <Provenance bullet={bullet} />
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
