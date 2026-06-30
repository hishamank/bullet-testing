'use client'

/**
 * Review & Confirm — the user-confirmation surface for the extraction envelope. Pending
 * suggestions are gathered under the bullet they came from; the user stages (checkbox), edits
 * (tasks), dismisses, or batch-accepts. Wired to `suggestions.listPending / accept / reject / edit`.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { EmptyState } from '@/components/empty-state'
import { SuggestionRow } from '@/components/review/suggestion-row'
import { formatTime, shortDay } from '@/lib/format'
import { useTRPC } from '@/lib/trpc'
import type { Bullet, Suggestion, SuggestionPayload } from '@/lib/types'
import { useJournalData } from '@/lib/use-journal-data'
import { groupBy, indexBy, suggestionRow } from '@/lib/view-model'

interface Group {
  bulletId: string
  bullet?: Bullet
  items: Suggestion[]
}

export default function ReviewPage() {
  const { suggestions, bulletsById, trackersById, isError, isLoading } = useJournalData()
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const accept = useMutation(trpc.suggestions.accept.mutationOptions())
  const reject = useMutation(trpc.suggestions.reject.mutationOptions())
  const edit = useMutation(trpc.suggestions.edit.mutationOptions())
  const weeklyRun = useMutation(trpc.weekly.run.mutationOptions())

  const [staged, setStaged] = useState<Set<string>>(() => new Set())
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [notice, setNotice] = useState<{ text: string; tone: 'info' | 'error' } | null>(null)

  const byId = useMemo(() => indexBy(suggestions, (s) => s.id), [suggestions])

  const groups = useMemo<Group[]>(() => {
    const grouped = groupBy(suggestions, (s) => s.source_bullet_id)
    return [...grouped.entries()]
      .map(([bulletId, items]) => ({ bulletId, bullet: bulletsById.get(bulletId), items }))
      .sort((a, b) => (b.bullet?.created_at ?? 0) - (a.bullet?.created_at ?? 0))
  }, [suggestions, bulletsById])

  const confidentIds = useMemo(
    () => suggestions.filter((s) => s.tier === 'suggest').map((s) => s.id),
    [suggestions],
  )

  function toggleStage(id: string) {
    setStaged((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function run(fn: () => Promise<void>) {
    setWorking(true)
    setNotice(null)
    try {
      await fn()
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Something went wrong — please try again.',
        tone: 'error',
      })
    } finally {
      setStaged(new Set())
      setExpandedId(null)
      setWorking(false)
      void queryClient.invalidateQueries()
    }
  }

  // Resolve a batch concurrently and surface partial failure, so one bad item doesn't silently
  // abandon the rest (and the user sees what landed). Settled — never throws, owns its own notice.
  async function batchResolve(
    ids: string[],
    op: (id: string) => Promise<unknown>,
    verb: string,
  ): Promise<void> {
    if (ids.length === 0) return
    const results = await Promise.allSettled(ids.map(op))
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (rejected.length > 0) {
      const reason =
        rejected[0]?.reason instanceof Error ? rejected[0].reason.message : 'please try again'
      setNotice({
        text: `${ids.length - rejected.length} ${verb}, ${rejected.length} failed — ${reason}`,
        tone: 'error',
      })
    }
  }

  const acceptIds = (ids: string[]) =>
    run(() => batchResolve(ids, (id) => accept.mutateAsync({ id }), 'accepted'))

  const dismissIds = (ids: string[]) =>
    run(() => batchResolve(ids, (id) => reject.mutateAsync({ id }), 'dismissed'))

  const applyEdit = (id: string, payload: SuggestionPayload) =>
    run(async () => {
      await edit.mutateAsync({ id, payload })
    })

  // Manual weekly-review trigger: analyze + persist on the server, then the query invalidation in
  // `run` refreshes listPending so any new tracker suggestions flow into the inbox below.
  const runWeekly = () =>
    run(async () => {
      const found = await weeklyRun.mutateAsync()
      setNotice({
        text:
          found.length > 0
            ? `Found ${found.length} pattern${found.length === 1 ? '' : 's'} to review.`
            : 'No new patterns yet — keep logging.',
        tone: 'info',
      })
    })

  const count = suggestions.length
  const stagedIds = [...staged]
  const hasItems = count > 0

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex-none border-line border-b px-10 pt-[22px] pb-4 max-md:px-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-[14px]">
            <span className="font-display text-[27px] text-ink">Review</span>
            {hasItems && (
              <span className="inline-flex items-center gap-[6px] rounded-[14px] bg-indigo px-[11px] py-[3px] font-data text-[12px] text-white">
                {count} to review
              </span>
            )}
          </div>
          <div className="flex items-center gap-[10px]">
            {/* Always visible — running a weekly review is exactly what you do when the inbox is empty. */}
            <button
              type="button"
              disabled={working}
              onClick={() => runWeekly()}
              className="rounded-[20px] border border-line-cool px-[15px] py-2 font-ui text-[13px] text-muted-soft transition-colors hover:border-faint-3 disabled:opacity-50"
            >
              Run weekly review
            </button>
            {hasItems && (
              <>
                <button
                  type="button"
                  disabled={working}
                  onClick={() => dismissIds(suggestions.map((s) => s.id))}
                  className="rounded-[20px] border border-line-cool px-[15px] py-2 font-ui text-[13px] text-muted-soft transition-colors hover:border-faint-3 disabled:opacity-50"
                >
                  Dismiss all
                </button>
                <button
                  type="button"
                  disabled={working || (stagedIds.length === 0 && confidentIds.length === 0)}
                  onClick={() => acceptIds(stagedIds.length > 0 ? stagedIds : confidentIds)}
                  className="rounded-[20px] bg-indigo px-[17px] py-[9px] font-ui font-medium text-[13px] text-white transition-colors hover:bg-indigo-deep disabled:opacity-50"
                >
                  {stagedIds.length > 0
                    ? `Accept ${stagedIds.length} selected`
                    : 'Accept all confident'}
                </button>
              </>
            )}
          </div>
        </div>
        {hasItems && (
          <p className="mt-[9px] max-w-[760px] font-ui text-[12.5px] text-faint">
            “Accept all confident” takes the {confidentIds.length} high-confidence{' '}
            {confidentIds.length === 1 ? 'item' : 'items'} and leaves the ones that need your call.
            Accepting re-checks against what's already tracked, so nothing duplicates.
          </p>
        )}
        {notice &&
          (notice.tone === 'error' ? (
            <p className="mt-[9px] font-ui text-[12.5px] text-rust" role="alert">
              {notice.text}
            </p>
          ) : (
            <p className="mt-[9px] font-ui text-[12.5px] text-faint" role="status">
              {notice.text}
            </p>
          ))}
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-10 pt-2 pb-6 max-md:px-5">
        {isError ? (
          <EmptyState
            glyphs="•  ○  —"
            title="The journal server is asleep."
            body="Couldn't reach the local server on :3001. Start it, and anything waiting to be sorted will gather here."
            className="h-[60vh]"
          />
        ) : !hasItems && !isLoading ? (
          <EmptyState
            glyphs="•  ○  —"
            title="You're all caught up."
            body="Nothing waiting on you. Keep emptying your head — anything worth sorting will gather here, and it'll wait as long as you need."
            className="h-[60vh]"
          />
        ) : (
          groups.map((g) => (
            <div
              key={g.bulletId}
              className="grid grid-cols-1 gap-4 border-line-soft border-b py-5 md:grid-cols-[250px_1fr] md:gap-x-11"
            >
              <div>
                {g.bullet && (
                  <div className="mb-[6px] font-data text-[10.5px] text-faint-3 tracking-[0.08em]">
                    {shortDay(g.bullet.created_at)} · {formatTime(g.bullet.created_at)}
                  </div>
                )}
                <div className="border-line-warm border-l-2 pl-[13px] font-reader text-[15.5px] text-muted italic leading-relaxed">
                  {g.bullet?.text ?? 'this bullet'}
                </div>
                <button
                  type="button"
                  disabled={working}
                  onClick={() => acceptIds(g.items.map((s) => s.id))}
                  className="mt-[11px] ml-[13px] font-ui text-[12.5px] text-indigo hover:underline disabled:opacity-50"
                >
                  Accept all from this bullet →
                </button>
              </div>
              <div>
                {g.items.map((s) => (
                  <SuggestionRow
                    key={s.id}
                    row={suggestionRow(s, trackersById, staged.has(s.id))}
                    payload={byId.get(s.id)?.payload ?? {}}
                    expanded={expandedId === s.id}
                    busy={working}
                    onToggleStage={() => toggleStage(s.id)}
                    onDismiss={() => dismissIds([s.id])}
                    onToggleEdit={() => setExpandedId((cur) => (cur === s.id ? null : s.id))}
                    onApplyEdit={(payload) => applyEdit(s.id, payload)}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
