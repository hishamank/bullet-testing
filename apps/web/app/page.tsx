'use client'

/**
 * Stream — the capture screen. A message-style journal where no one replies: you empty your head
 * one bullet at a time, and the agent quietly sorts tasks, activities and trackers into the margin.
 * Wired to `bullets.create` / `bullets.list` and the SSE extraction bridge.
 */

import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { EmptyState } from '@/components/empty-state'
import { BulletRow } from '@/components/stream/bullet-row'
import { Composer } from '@/components/stream/composer'
import { fullDateLine } from '@/lib/format'
import { useTRPC } from '@/lib/trpc'
import { useExtractionEvents } from '@/lib/use-extraction-events'
import { useJournalData } from '@/lib/use-journal-data'

export default function StreamPage() {
  const { bullets, entitiesByBulletId, pendingByBulletId, isLoading, isError } = useJournalData()
  const trpc = useTRPC()
  const [processing, setProcessing] = useState<Set<string>>(() => new Set())
  // Per-bullet failure messages: a failed extraction must be VISIBLE, never silent.
  const [errors, setErrors] = useState<Map<string, string>>(() => new Map())
  const scrollRef = useRef<HTMLDivElement>(null)
  // Fallback timers keyed by bullet id, so a settled/cleared bullet cancels its own timer.
  const timers = useRef<Map<string, number>>(new Map())

  // Poll Ollama's health so the "model offline" banner appears AND recovers (every 15s) once the
  // server is back — without a manual refresh.
  const healthQ = useQuery(
    trpc.system.ollamaHealth.queryOptions(undefined, { refetchInterval: 15_000 }),
  )
  const modelOffline =
    !!healthQ.data && (!healthQ.data.reachable || !healthQ.data.liveModelAvailable)

  const setError = useCallback((id: string, message: string) => {
    setErrors((prev) => {
      const next = new Map(prev)
      next.set(id, message)
      return next
    })
  }, [])

  const clearError = useCallback((id: string) => {
    setErrors((prev) => {
      if (!prev.has(id)) return prev
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }, [])

  const clearProcessing = useCallback((id: string) => {
    const timer = timers.current.get(id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timers.current.delete(id)
    }
    setProcessing((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  // The worker tells us a bullet finished reading → drop "reading…" and clear any prior error.
  // An error event clears the spinner AND records the failure so the row can offer a retry. An
  // error may carry a null bulletId (the bullet was unreadable) — nothing to attach it to.
  useExtractionEvents({
    onComplete: (e) => {
      clearError(e.bulletId)
      clearProcessing(e.bulletId)
    },
    onError: (e) => {
      if (e.bulletId) {
        setError(e.bulletId, e.error || 'Extraction failed.')
        clearProcessing(e.bulletId)
      }
    },
  })

  const markProcessing = useCallback(
    (id: string) => {
      clearError(id)
      setProcessing((prev) => new Set(prev).add(id))
      // Fallback in case no event arrives (the model is slow/backed-up on the single serial slot,
      // or offline) — don't spin forever. On timeout we surface a SOFT error inviting a retry
      // rather than silently clearing the row.
      timers.current.set(
        id,
        window.setTimeout(() => {
          clearProcessing(id)
          setError(id, 'No response yet — the model may be slow or offline. Retry?')
        }, 30_000),
      )
    },
    [clearProcessing, clearError, setError],
  )

  // Cancel any outstanding fallback timers on unmount.
  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const t of pending.values()) window.clearTimeout(t)
      pending.clear()
    }
  }, [])

  // Keep the latest bullet in view as the stream grows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on stream length change
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [bullets.length])

  return (
    <div className="flex h-full flex-col">
      <div className="flex-none px-10 pt-5 max-md:px-5 max-md:pt-3">
        <div className="flex items-baseline gap-3">
          <span className="font-display text-[26px] text-ink max-md:text-[21px]">Today</span>
          <span className="font-data text-[12px] text-faint-2">{fullDateLine()}</span>
        </div>
      </div>

      {modelOffline && (
        <div className="flex-none px-10 pt-3 max-md:px-5">
          <div className="mx-auto max-w-[880px] rounded-lg border border-rust/30 bg-rust/5 px-3 py-2 font-data text-[12px] text-rust leading-relaxed">
            {healthQ.data?.reachable === false
              ? "The local model isn't reachable — start Ollama. Bullets won't be processed until it's back."
              : `The model "${healthQ.data?.liveModel}" isn't installed — run \`ollama pull ${healthQ.data?.liveModel}\`. Bullets won't be processed until it's back.`}
          </div>
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-10 pt-4 pb-5 max-md:px-5">
        <div className="mx-auto max-w-[880px]">
          {isError ? (
            <EmptyState
              glyphs="•  ○  —"
              title="The journal server is asleep."
              body="Couldn't reach the local server on :3001. Start it with `pnpm --filter @bullet/server dev`, then your bullets will appear here."
              className="h-[60vh]"
            />
          ) : bullets.length === 0 && !isLoading ? (
            <EmptyState
              glyphs="•  ○  —"
              title="Nothing here yet — and that's the point."
              body="Type a thought and press enter. Keep going, one bullet at a time. I'll read each one and quietly sort tasks, activities and trackers into the margin."
              className="h-[60vh]"
            />
          ) : (
            bullets.map((b) => (
              <BulletRow
                key={b.id}
                bullet={b}
                entities={entitiesByBulletId.get(b.id) ?? []}
                pendingCount={pendingByBulletId.get(b.id)?.length ?? 0}
                processing={processing.has(b.id)}
                error={errors.get(b.id)}
                onReprocess={markProcessing}
              />
            ))
          )}
        </div>
      </div>

      <div className="flex-none bg-[linear-gradient(to_top,#f6f5f1_72%,transparent)] px-10 pt-3 pb-6 max-md:px-4 max-md:pb-4">
        <div className="mx-auto max-w-[760px]">
          <Composer onCreated={markProcessing} />
        </div>
      </div>
    </div>
  )
}
