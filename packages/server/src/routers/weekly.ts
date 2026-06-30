/**
 * weekly router — the manual trigger for the weekly pattern analyzer. Both procedures are thin
 * wrappers over `ctx.runtime.weekly` (the analyzer owns the read/group/dedup + persist logic):
 *
 *  - `preview` analyzes the owner's unlinked activities and returns the deduped proposals WITHOUT
 *    persisting anything — analysis only, a pure read.
 *  - `run` analyzes + persists those proposals as pending Suggestions and returns them. Re-running
 *    is idempotent — the analyzer skips names already backed by a tracker or a pending/rejected
 *    suggestion.
 */

import { publicProcedure, router } from '../trpc'

export const weeklyRouter = router({
  /** Deduped tracker-definition proposals for the owner — analysis only, nothing persisted. */
  preview: publicProcedure.query(({ ctx }) => ctx.runtime.weekly.analyze(ctx.ownerId)),

  /** Analyze + persist: store the deduped proposals as pending Suggestions; returns them. */
  run: publicProcedure.mutation(({ ctx }) =>
    ctx.runtime.weekly.persist(ctx.ownerId, ctx.runtime.weekly.analyze(ctx.ownerId)),
  ),
})
