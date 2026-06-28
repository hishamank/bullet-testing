/**
 * tasks router — owner-scoped CRUD, each procedure a thin wrapper over the @bullet/db tasks repo.
 * Manually-created entities carry `source_bullet_id: null` (no provenance bullet).
 */

import { createTask, listTasks, softDeleteTask, updateTask } from '@bullet/db'
import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '../trpc'
import { byIdInput, taskCreateInput, taskUpdateInput } from './inputs'

export const tasksRouter = router({
  list: publicProcedure.query(({ ctx }) => listTasks(ctx.db, ctx.ownerId)),

  create: publicProcedure
    .input(taskCreateInput)
    .mutation(({ ctx, input }) =>
      createTask(ctx.db, { ...input, owner_id: ctx.ownerId, source_bullet_id: null }),
    ),

  // TODO(multi-user): owner-scope by-id access (verify row.owner_id === ctx.ownerId) before
  // multi-user. update/delete resolve a task purely by id — fine for single-user v1.

  update: publicProcedure.input(taskUpdateInput).mutation(({ ctx, input }) => {
    const { id, ...patch } = input
    const updated = updateTask(ctx.db, id, patch)
    if (!updated) throw new TRPCError({ code: 'NOT_FOUND', message: `task ${id} not found` })
    return updated
  }),

  delete: publicProcedure.input(byIdInput).mutation(({ ctx, input }) => {
    const deleted = softDeleteTask(ctx.db, input.id)
    if (!deleted) throw new TRPCError({ code: 'NOT_FOUND', message: `task ${input.id} not found` })
    return deleted
  }),
})
