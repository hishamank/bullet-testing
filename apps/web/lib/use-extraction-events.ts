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
  bulletId: string
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
      // Broad invalidation is fine for a single-user local app — every list is cheap to refetch.
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
