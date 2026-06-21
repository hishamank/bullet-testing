/**
 * activities router — owner-scoped CRUD over the @bullet/db activities repo. An Activity is a
 * record of something the user did (optionally linked to a Tracker); each procedure is thin.
 */

import { createActivity, listActivities, softDeleteActivity, updateActivity } from '@bullet/db'
import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '../trpc'
import { activityCreateInput, activityUpdateInput, byIdInput } from './inputs'

export const activitiesRouter = router({
  list: publicProcedure.query(({ ctx }) => listActivities(ctx.db, ctx.ownerId)),

  create: publicProcedure
    .input(activityCreateInput)
    .mutation(({ ctx, input }) =>
      createActivity(ctx.db, { ...input, owner_id: ctx.ownerId, source_bullet_id: null }),
    ),

  update: publicProcedure.input(activityUpdateInput).mutation(({ ctx, input }) => {
    const { id, ...patch } = input
    const updated = updateActivity(ctx.db, id, patch)
    if (!updated) throw new TRPCError({ code: 'NOT_FOUND', message: `activity ${id} not found` })
    return updated
  }),

  delete: publicProcedure.input(byIdInput).mutation(({ ctx, input }) => {
    const deleted = softDeleteActivity(ctx.db, input.id)
    if (!deleted)
      throw new TRPCError({ code: 'NOT_FOUND', message: `activity ${input.id} not found` })
    return deleted
  }),
})
