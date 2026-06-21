/**
 * system router — liveness + a round-trip echo, used by the Task 5 web scaffold to confirm the
 * client/server wiring end-to-end.
 */

import { z } from 'zod'
import { publicProcedure, router } from '../trpc'

export const systemRouter = router({
  /** Liveness: `{ ok: true, now }`. */
  health: publicProcedure.query(() => ({ ok: true as const, now: Date.now() })),

  /** Echo the message back (round-trip smoke test). */
  echo: publicProcedure
    .input(z.object({ message: z.string() }))
    .query(({ input }) => ({ message: input.message })),
})
