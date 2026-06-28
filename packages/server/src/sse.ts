/**
 * The Server-Sent-Events bridge from the agent emitter to the browser.
 *
 * `GET /events` subscribes to `ctx.emitter` ('extraction:complete' / 'extraction:error') and
 * writes each as an SSE message, so the UI can react to "your bullet produced these suggestions"
 * in real time. Listeners are removed on disconnect so a long-lived page never leaks them.
 *
 * The route is a thin transport: it does not run any pipeline code — it only re-broadcasts the
 * events the worker already emits. Built over `hono/streaming`'s `streamSSE`, so it is testable
 * in-process via `app.request('/events')` without binding a socket.
 */

import type { AgentEmitter, ExtractionCompleteEvent, ExtractionErrorEvent } from '@bullet/agent'
import type { Context as HonoContext } from 'hono'
import { streamSSE } from 'hono/streaming'

/** The SSE event names mirrored from the agent emitter. */
export const SSE_EVENTS = ['extraction:complete', 'extraction:error'] as const

/**
 * Stream the agent's extraction events to one SSE client. Resolves when the client disconnects
 * (the stream is aborted), at which point both emitter listeners are detached.
 */
export function streamAgentEvents(c: HonoContext, emitter: AgentEmitter): Response {
  return streamSSE(c, async (stream) => {
    // Bridge each emitter event into an SSE write. We keep references so they can be removed.
    const onComplete = (payload: ExtractionCompleteEvent): void => {
      void stream.writeSSE({ event: 'extraction:complete', data: JSON.stringify(payload) })
    }
    const onError = (payload: ExtractionErrorEvent): void => {
      void stream.writeSSE({ event: 'extraction:error', data: JSON.stringify(payload) })
    }

    emitter.on('extraction:complete', onComplete)
    emitter.on('extraction:error', onError)

    // Hold the stream open until the client disconnects (the stream is aborted). At that point
    // detach both listeners so a long-lived page never accumulates subscriptions, and resolve so
    // `streamSSE` closes the response.
    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        emitter.off('extraction:complete', onComplete)
        emitter.off('extraction:error', onError)
        resolve()
      })
    })
  })
}
