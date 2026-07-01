/**
 * weekly router — the manual trigger for the weekly pattern analyzer. `run` is a thin wrapper over
 * `ctx.runtime.weekly` (the analyzer owns the read/group/dedup + persist logic): it analyzes the
 * owner's unlinked activities + persists the deduped proposals as pending Suggestions and returns
 * them. Re-running is idempotent — the analyzer skips names already backed by a tracker or a
 * pending/rejected suggestion.
 */

import { publicProcedure, router } from '../trpc'

export const weeklyRouter = router({
  /** Analyze + persist: store the deduped proposals as pending Suggestions; returns them. */
  run: publicProcedure.mutation(({ ctx }) =>
    ctx.runtime.weekly.persist(ctx.ownerId, ctx.runtime.weekly.analyze(ctx.ownerId)),
  ),
})
