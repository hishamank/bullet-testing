/**
 * trackers router — owner-scoped CRUD over the @bullet/db trackers repo. A Tracker is a
 * definition (created once, then logged against); each procedure stays a thin wrapper.
 */

import { createTracker, listTrackers, softDeleteTracker, updateTracker } from '@bullet/db'
import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '../trpc'
import { byIdInput, trackerCreateInput, trackerUpdateInput } from './inputs'

export const trackersRouter = router({
  list: publicProcedure.query(({ ctx }) => listTrackers(ctx.db, ctx.ownerId)),

  create: publicProcedure
    .input(trackerCreateInput)
    .mutation(({ ctx, input }) =>
      createTracker(ctx.db, { ...input, owner_id: ctx.ownerId, source_bullet_id: null }),
    ),

  update: publicProcedure.input(trackerUpdateInput).mutation(({ ctx, input }) => {
    const { id, ...patch } = input
    const updated = updateTracker(ctx.db, id, patch)
    if (!updated) throw new TRPCError({ code: 'NOT_FOUND', message: `tracker ${id} not found` })
    return updated
  }),

  delete: publicProcedure.input(byIdInput).mutation(({ ctx, input }) => {
    const deleted = softDeleteTracker(ctx.db, input.id)
    if (!deleted)
      throw new TRPCError({ code: 'NOT_FOUND', message: `tracker ${input.id} not found` })
    return deleted
  }),
})
