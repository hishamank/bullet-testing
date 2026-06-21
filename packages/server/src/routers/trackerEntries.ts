/**
 * trackerEntries router — owner-scoped CRUD over the @bullet/db trackerEntries repo. A
 * TrackerEntry is a record logged against a Tracker; each procedure stays a thin wrapper.
 */

import {
  createTrackerEntry,
  listTrackerEntries,
  softDeleteTrackerEntry,
  updateTrackerEntry,
} from '@bullet/db'
import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '../trpc'
import { byIdInput, trackerEntryCreateInput, trackerEntryUpdateInput } from './inputs'

export const trackerEntriesRouter = router({
  list: publicProcedure.query(({ ctx }) => listTrackerEntries(ctx.db, ctx.ownerId)),

  create: publicProcedure
    .input(trackerEntryCreateInput)
    .mutation(({ ctx, input }) =>
      createTrackerEntry(ctx.db, { ...input, owner_id: ctx.ownerId, source_bullet_id: null }),
    ),

  update: publicProcedure.input(trackerEntryUpdateInput).mutation(({ ctx, input }) => {
    const { id, ...patch } = input
    const updated = updateTrackerEntry(ctx.db, id, patch)
    if (!updated)
      throw new TRPCError({ code: 'NOT_FOUND', message: `tracker entry ${id} not found` })
    return updated
  }),

  delete: publicProcedure.input(byIdInput).mutation(({ ctx, input }) => {
    const deleted = softDeleteTrackerEntry(ctx.db, input.id)
    if (!deleted)
      throw new TRPCError({ code: 'NOT_FOUND', message: `tracker entry ${input.id} not found` })
    return deleted
  }),
})
