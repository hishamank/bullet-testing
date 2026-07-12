'use client'

/**
 * Trackers — the measured life. A grid of trackers, each with a visualization matched to how it's
 * logged, one-tap logging, and a detail view whose chart fits the schema (scale → trend + year in
 * pixels · number → trend · boolean → streak + heatmap · select/text → history). Plus an honest
 * "quiet pattern" note when a same-day co-occurrence clears a real sample threshold.
 *
 * Wired to the live `trackers.*` / `trackerEntries.*` procedures and the read-only
 * `trackerAnalytics.*` roll-ups; all shaping lives in `lib/trackers-view-model`. This component owns
 * data + persistence and stays declarative.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import { EmptyState } from '@/components/empty-state'
import { LogDialog } from '@/components/trackers/log-dialog'
import { QuietPattern } from '@/components/trackers/quiet-pattern'
import { TrackerCard } from '@/components/trackers/tracker-card'
import { TrackerDetail } from '@/components/trackers/tracker-detail'
import { TrackerForm } from '@/components/trackers/tracker-form'
import {
  EMPTY_TRACKER_FORM,
  entriesByTracker,
  type LogValue,
  logEntryPayload,
  type TrackerFormValues,
  trackerCardVM,
  trackerFormValues,
  trackersLoggedTodayCount,
  trackerWritePayload,
} from '@/lib/trackers-view-model'
import { useTRPC } from '@/lib/trpc'
import { useJournalData } from '@/lib/use-journal-data'

/** A syntactically-valid placeholder id for disabled per-tracker queries (never actually run). */
const NO_TRACKER = '00000000-0000-4000-8000-000000000000'

type View = 'list' | 'detail' | 'form'

/** First-run empty state — trackers surface from what you write, so point back to the stream. */
function TrackersEmpty({
  onNew,
  addRef,
}: {
  onNew: () => void
  addRef?: React.Ref<HTMLButtonElement>
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-10 py-16 text-center">
      <div className="mb-5 font-data text-[20px] text-ochre tracking-[0.32em]">
        —&nbsp;&nbsp;∿&nbsp;&nbsp;—
      </div>
      <h2 className="mb-[10px] font-display text-[31px] text-ink max-md:text-[26px]">
        Nothing measured yet.
      </h2>
      <p className="m-0 mb-6 max-w-[380px] font-reader text-[16.5px] text-muted leading-relaxed">
        Trackers are the quantities you watch over time — mood, sleep, coffee, a habit. Mention one
        in the stream and Review will offer to track it, or start one by hand.
      </p>
      <Link
        href="/"
        className="inline-flex items-center gap-[9px] rounded-[24px] bg-ochre px-[22px] py-3 font-ui font-medium text-[14px] text-white transition-colors hover:bg-ochre-deep"
      >
        <span className="font-data text-[13px]">✎</span>Open the stream
      </Link>
      <button
        ref={addRef}
        type="button"
        onClick={onNew}
        className="mt-[14px] font-ui text-[13px] text-faint transition-colors hover:text-ochre"
      >
        or add one by hand →
      </button>
    </div>
  )
}

export default function TrackersPage() {
  const { trackers, trackerEntries, bulletsById, isError, isLoading } = useJournalData()
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const createTracker = useMutation(trpc.trackers.create.mutationOptions())
  const updateTracker = useMutation(trpc.trackers.update.mutationOptions())
  const deleteTracker = useMutation(trpc.trackers.delete.mutationOptions())
  const createEntry = useMutation(trpc.trackerEntries.create.mutationOptions())
  const deleteEntry = useMutation(trpc.trackerEntries.delete.mutationOptions())

  const [view, setView] = useState<View>('list')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [logTrackerId, setLogTrackerId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const newTrackerRef = useRef<HTMLButtonElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const [wantRestore, setWantRestore] = useState(false)

  const tz = useMemo(() => -new Date().getTimezoneOffset(), [])
  const year = useMemo(() => new Date().getFullYear(), [])

  const byTracker = useMemo(() => entriesByTracker(trackerEntries), [trackerEntries])
  const activeTrackers = trackers // list() already filters soft-deleted

  const selected = useMemo(
    () => activeTrackers.find((t) => t.id === selectedId),
    [activeTrackers, selectedId],
  )
  const editing = useMemo(
    () => (editingId ? activeTrackers.find((t) => t.id === editingId) : undefined),
    [editingId, activeTrackers],
  )
  const logTracker = useMemo(
    () => activeTrackers.find((t) => t.id === logTrackerId),
    [activeTrackers, logTrackerId],
  )

  const isScale = selected?.input_type === 'scale'
  const isNumeric = isScale || selected?.input_type === 'number'
  const isBoolean = selected?.input_type === 'boolean'
  const analyticsOn = view === 'detail' && !!selected
  const input = { trackerId: selectedId ?? NO_TRACKER, tzOffsetMinutes: tz }

  const seriesQ = useQuery(
    trpc.trackerAnalytics.dailySeries.queryOptions(input, { enabled: analyticsOn && isNumeric }),
  )
  const yearQ = useQuery(
    trpc.trackerAnalytics.yearInPixels.queryOptions(
      { ...input, year },
      { enabled: analyticsOn && isScale },
    ),
  )
  const streaksQ = useQuery(
    trpc.trackerAnalytics.streaks.queryOptions(input, { enabled: analyticsOn && isBoolean }),
  )
  const quietQ = useQuery(trpc.trackerAnalytics.quietPattern.queryOptions({ tzOffsetMinutes: tz }))

  const analyticsLoading = Boolean(
    (isNumeric && seriesQ.isLoading) || (isBoolean && streaksQ.isLoading),
  )

  useEffect(() => {
    if (view === 'list' && wantRestore) {
      ;(restoreFocusRef.current ?? newTrackerRef.current)?.focus()
      restoreFocusRef.current = null
      setWantRestore(false)
    }
  }, [view, wantRestore])

  async function run(fn: () => Promise<void>) {
    setBusy(true)
    setNotice(null)
    try {
      await fn()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Something went wrong — please try again.')
    } finally {
      setBusy(false)
      void queryClient.invalidateQueries()
    }
  }

  // --- navigation ---------------------------------------------------------------------------

  const openNew = () => {
    setEditingId(null)
    setNotice(null)
    setView('form')
  }
  const openDetail = (id: string) => {
    setSelectedId(id)
    setNotice(null)
    setView('detail')
  }
  const openEditSelected = () => {
    if (!selected) return
    setEditingId(selected.id)
    setNotice(null)
    setView('form')
  }
  const backToList = () => {
    setView('list')
    setEditingId(null)
    setNotice(null)
    setWantRestore(true)
  }
  const backFromDetail = () => {
    setView('list')
    setSelectedId(null)
    setNotice(null)
    setWantRestore(true)
  }

  const openLog = (id: string) => {
    restoreFocusRef.current = (document.activeElement as HTMLElement | null) ?? null
    setLogTrackerId(id)
    setNotice(null)
  }
  const closeLog = () => {
    setLogTrackerId(null)
    restoreFocusRef.current?.focus()
    restoreFocusRef.current = null
  }

  // --- mutations ----------------------------------------------------------------------------

  const submitForm = (values: TrackerFormValues) =>
    run(async () => {
      const payload = trackerWritePayload(values)
      if (editing) await updateTracker.mutateAsync({ id: editing.id, ...payload })
      else await createTracker.mutateAsync(payload)
      backToList()
    })

  const deleteEditing = () => {
    if (!editing) return
    const id = editing.id
    return run(async () => {
      await deleteTracker.mutateAsync({ id })
      if (selectedId === id) setSelectedId(null)
      backToList()
    })
  }

  const submitLog = (value: LogValue) => {
    if (!logTracker) return
    const t = logTracker
    return run(async () => {
      await createEntry.mutateAsync(logEntryPayload(t, value))
      closeLog()
    })
  }

  const removeEntry = (id: string) =>
    run(async () => {
      await deleteEntry.mutateAsync({ id })
    })

  // --- render -------------------------------------------------------------------------------

  const logDialog = logTracker ? (
    <LogDialog
      tracker={logTracker}
      busy={busy}
      notice={notice}
      onSubmit={submitLog}
      onClose={closeLog}
    />
  ) : null

  // Form first — a connectivity error (incl. one from a failed submit's refetch) surfaces on the
  // form, never yanking the user out of a half-filled tracker.
  if (view === 'form') {
    return (
      <>
        <TrackerForm
          heading={editing ? 'Edit tracker' : 'New tracker'}
          submitLabel={editing ? 'Save changes' : 'Create tracker'}
          initial={editing ? trackerFormValues(editing) : EMPTY_TRACKER_FORM}
          isEdit={!!editing}
          hasEntries={editing ? (byTracker.get(editing.id)?.length ?? 0) > 0 : false}
          busy={busy}
          notice={notice}
          onSubmit={submitForm}
          onCancel={backToList}
          onDelete={editing ? deleteEditing : undefined}
        />
        {logDialog}
      </>
    )
  }

  if (view === 'detail' && selected) {
    return (
      <>
        <TrackerDetail
          tracker={selected}
          entries={byTracker.get(selected.id) ?? []}
          bulletsById={bulletsById}
          analytics={{
            series: seriesQ.data,
            yearInPixels: yearQ.data,
            streaks: streaksQ.data,
            loading: analyticsLoading,
          }}
          busy={busy}
          onBack={backFromDetail}
          onLog={() => openLog(selected.id)}
          onEdit={openEditSelected}
          onDeleteEntry={removeEntry}
        />
        {notice && (
          <p className="px-10 pb-6 text-right font-ui text-[12.5px] text-rust" role="alert">
            {notice}
          </p>
        )}
        {logDialog}
      </>
    )
  }

  const hasTrackers = activeTrackers.length > 0

  // Full-screen error ONLY when nothing is cached. A background refetch failure with trackers
  // already on screen keeps the grid and shows an inline alert instead (review nit).
  if (isError && !hasTrackers) {
    return (
      <EmptyState
        glyphs="—  ∿  —"
        title="The journal server is asleep."
        body="Couldn't reach the local server on :3001. Start it, and everything you're measuring will gather here."
      />
    )
  }

  if (!hasTrackers) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex-none border-line border-b px-10 pt-[26px] pb-4 max-md:px-5">
          <h2 className="font-display text-[27px] text-ink">Trackers</h2>
        </div>
        {isLoading ? (
          <div className="flex flex-1 items-center justify-center font-ui text-[14px] text-faint">
            Gathering your trackers…
          </div>
        ) : (
          <>
            <TrackersEmpty onNew={openNew} addRef={newTrackerRef} />
            {logDialog}
          </>
        )}
      </div>
    )
  }

  const loggedToday = trackersLoggedTodayCount(byTracker)

  return (
    <div className="px-10 pt-[34px] pb-16 max-md:px-5 max-md:pt-6">
      <div className="mx-auto max-w-[1000px]">
        <div className="flex items-end justify-between gap-6">
          <div>
            <div className="font-data text-[11px] text-faint-2 uppercase tracking-[0.14em]">
              {activeTrackers.length} {activeTrackers.length === 1 ? 'tracker' : 'trackers'} ·{' '}
              {loggedToday} logged today
            </div>
            <h2 className="mt-[6px] font-display text-[34px] text-ink max-md:text-[28px]">
              Trackers
            </h2>
          </div>
          <button
            ref={newTrackerRef}
            type="button"
            onClick={openNew}
            className="inline-flex items-center gap-2 rounded-[22px] bg-ochre px-[17px] py-[10px] font-ui font-medium text-[13.5px] text-white transition-colors hover:bg-ochre-deep"
          >
            <span className="font-data text-[14px]">+</span>New tracker
          </button>
        </div>

        {isError && (
          <p className="mt-3 font-ui text-[12.5px] text-rust" role="alert">
            Couldn't refresh from the server — showing the last data loaded.
          </p>
        )}
        {notice && (
          <p className="mt-3 font-ui text-[12.5px] text-rust" role="alert">
            {notice}
          </p>
        )}

        <div className="mt-[22px] grid grid-cols-3 gap-4 max-lg:grid-cols-2 max-sm:grid-cols-1">
          {activeTrackers.map((tracker) => (
            <TrackerCard
              key={tracker.id}
              vm={trackerCardVM(tracker, byTracker.get(tracker.id) ?? [])}
              onOpen={() => openDetail(tracker.id)}
              onLog={() => openLog(tracker.id)}
            />
          ))}
          <button
            type="button"
            onClick={openNew}
            className="flex min-h-[210px] flex-col items-center justify-center gap-[10px] rounded-[14px] border-[1.5px] border-line-cool border-dashed px-4 py-6 text-faint transition-colors hover:border-ochre hover:text-ochre"
          >
            <span className="font-data text-[24px] leading-none">+</span>
            <span className="font-ui font-medium text-[14px]">New tracker</span>
            <span className="max-w-[170px] text-center font-ui text-[12px] text-faint-2">
              A number, a scale, a yes/no — anything you want to watch.
            </span>
          </button>
        </div>

        {quietQ.data && <QuietPattern correlation={quietQ.data} />}
      </div>
      {logDialog}
    </div>
  )
}
