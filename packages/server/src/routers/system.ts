/**
 * system router — liveness + a round-trip echo, used by the Task 5 web scaffold to confirm the
 * client/server wiring end-to-end.
 */

import { checkOllamaHealth } from '@bullet/agent'
import { z } from 'zod'
import { publicProcedure, router } from '../trpc'

export const systemRouter = router({
  /** Liveness: `{ ok: true, now }`. */
  health: publicProcedure.query(() => ({ ok: true as const, now: Date.now() })),

  /** Echo the message back (round-trip smoke test). */
  echo: publicProcedure
    .input(z.object({ message: z.string() }))
    .query(({ input }) => ({ message: input.message })),

  /** Ollama reachability + whether the configured live model is pulled (drives the web banner). */
  ollamaHealth: publicProcedure.query(({ ctx }) => checkOllamaHealth(ctx)),
})
