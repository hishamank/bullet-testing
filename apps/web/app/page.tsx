'use client'

/**
 * Stream — the capture screen. A message-style journal where no one replies: you empty your head
 * one bullet at a time, and the agent quietly sorts tasks, activities and trackers into the margin.
 * Wired to `bullets.create` / `bullets.list` and the SSE extraction bridge.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { EmptyState } from '@/components/empty-state'
import { BulletRow } from '@/components/stream/bullet-row'
import { Composer } from '@/components/stream/composer'
import { fullDateLine } from '@/lib/format'
import { useExtractionEvents } from '@/lib/use-extraction-events'
import { useJournalData } from '@/lib/use-journal-data'

export default function StreamPage() {
  const { bullets, entitiesByBulletId, pendingByBulletId, isLoading, isError } = useJournalData()
  const [processing, setProcessing] = useState<Set<string>>(() => new Set())
  const scrollRef = useRef<HTMLDivElement>(null)

  const clearProcessing = useCallback((id: string) => {
    setProcessing((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  // The worker tells us a bullet finished reading; drop its "reading…" state.
  useExtractionEvents({
    onComplete: (e) => clearProcessing(e.bulletId),
    onError: (e) => clearProcessing(e.bulletId),
  })

  const markProcessing = useCallback(
    (id: string) => {
      setProcessing((prev) => new Set(prev).add(id))
      // Fallback in case no event arrives (e.g. the model is offline) — don't spin forever.
      window.setTimeout(() => clearProcessing(id), 30_000)
    },
    [clearProcessing],
  )

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
