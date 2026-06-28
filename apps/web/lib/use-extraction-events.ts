'use client'

/**
 * Subscribe to the server's Server-Sent-Events bridge (`GET /events`) and refresh the cache when
 * the agent worker finishes a bullet's extraction. The worker emits:
 *
 *  - `extraction:complete` — { jobId, bulletId, suggestionIds, appliedIds, failedAutoApplyIds }
 *  - `extraction:error`    — { jobId, bulletId, error }
 *
 * On any event we invalidate the active queries so newly-applied entities and pending suggestions
 * surface, and forward the parsed payload to an optional handler (the Stream uses it to clear a
 * bullet's "reading…" state). The EventSource auto-reconnects; we just detach on unmount.
 */

import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { API_URL } from '@/lib/trpc'

export interface ExtractionComplete {
  jobId: string
  bulletId: string
  suggestionIds: string[]
  appliedIds: string[]
  failedAutoApplyIds: string[]
}

export interface ExtractionError {
  jobId: string
  // Mirrors @bullet/agent's ExtractionErrorEvent: the bullet id may be missing/unreadable,
  // which is itself a failure mode. This hand-typed SSE seam has no compiler backstop against
  // the server contract (web can't import @bullet/agent), so keep it faithful by hand.
  bulletId: string | null
  error: string
}

interface Handlers {
  onComplete?: (e: ExtractionComplete) => void
  onError?: (e: ExtractionError) => void
}

export function useExtractionEvents(handlers: Handlers = {}): void {
  const queryClient = useQueryClient()
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  useEffect(() => {
    let source: EventSource
    try {
      source = new EventSource(`${API_URL}/events`)
    } catch {
      return
    }

    const refresh = () => {
      // TODO(review): invalidate-the-world on every SSE frame (and every mutation's onSuccess) is
      // fine for a single-user local app — every list is cheap and httpBatchLink coalesces — but a
      // create then its extraction:complete refetch everything twice. Revisit with scoped query keys
      // if it ever shows. — see REVIEW-BACKLOG.md
      void queryClient.invalidateQueries()
    }

    const onComplete = (ev: MessageEvent) => {
      refresh()
      try {
        handlersRef.current.onComplete?.(JSON.parse(ev.data) as ExtractionComplete)
      } catch {
        /* ignore malformed frame */
      }
    }
    const onError = (ev: MessageEvent) => {
      refresh()
      try {
        handlersRef.current.onError?.(JSON.parse(ev.data) as ExtractionError)
      } catch {
        /* ignore malformed frame */
      }
    }

    source.addEventListener('extraction:complete', onComplete)
    source.addEventListener('extraction:error', onError)

    return () => {
      source.removeEventListener('extraction:complete', onComplete)
      source.removeEventListener('extraction:error', onError)
      source.close()
    }
  }, [queryClient])
}
