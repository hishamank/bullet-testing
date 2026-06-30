/**
 * bullets router. The bullet is the atomic input unit and the provenance anchor; creating one
 * schedules extraction, editing one re-runs extraction (§4.7), deleting one offers the three
 * modes (§4.6). Every procedure is a thin wrapper over a @bullet/db repo / the @bullet/agent
 * runtime — no DB access or pipeline code lives here.
 */

import { createBullet, getBulletById, listBullets, softDelete, updateBullet } from '@bullet/db'
import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '../trpc'
import { bulletCreateInput, bulletDeleteInput, bulletUpdateInput, byIdInput } from './inputs'

export const bulletsRouter = router({
  /** Create a bullet, then enqueue its extraction job (the serial worker processes it). */
  create: publicProcedure.input(bulletCreateInput).mutation(async ({ ctx, input }) => {
    const bullet = createBullet(ctx.db, { owner_id: ctx.ownerId, text: input.text })
    await ctx.runtime.enqueueExtraction(bullet.id, ctx.ownerId)
    return bullet
  }),

  /** List the owner's active bullets. */
  list: publicProcedure.query(({ ctx }) => listBullets(ctx.db, ctx.ownerId)),

  // TODO(multi-user): owner-scope by-id access (verify row.owner_id === ctx.ownerId) before
  // multi-user. The get/update/delete procedures below resolve a bullet purely by id; correct and
  // harmless while v1 is single-user (one owner), but a leak vector once multiple owners share a db.

  /** Fetch one bullet by id. */
  get: publicProcedure.input(byIdInput).query(({ ctx, input }) => {
    const bullet = getBulletById(ctx.db, input.id)
    if (!bullet) throw new TRPCError({ code: 'NOT_FOUND', message: `bullet ${input.id} not found` })
    return bullet
  }),

  /**
   * Re-enqueue extraction for a bullet — the per-bullet RETRY after a failed/slow job (e.g. Ollama
   * was offline or backed up). The retry enqueues a RECONCILE job (`{ reconcile: true }`); the
   * serial FIFO worker runs it AFTER any in-flight original, and `reprocessBullet` retires stale
   * pending suggestions + dedupes creates against already-applied entities. So retrying is
   * IDEMPOTENT regardless of whether the original failed, partially persisted, or is still queued —
   * no duplicate suggestions/entities. (`bullets.update` is the path for EDITED text; this re-runs
   * the SAME text.)
   */
  reprocess: publicProcedure.input(byIdInput).mutation(({ ctx, input }) => {
    // Missing OR soft-deleted → NOT_FOUND (matching get/update; a deleted bullet can't be retried).
    if (getBulletById(ctx.db, input.id)?.state !== 'active')
      throw new TRPCError({ code: 'NOT_FOUND', message: `bullet ${input.id} not found` })
    return ctx.runtime.enqueueExtraction(input.id, ctx.ownerId, { reconcile: true })
  }),

  /** Edit a bullet's text, then re-run extraction reconciling against applied entities (§4.7). */
  update: publicProcedure.input(bulletUpdateInput).mutation(async ({ ctx, input }) => {
    const bullet = updateBullet(ctx.db, input.id, { text: input.text })
    if (!bullet) throw new TRPCError({ code: 'NOT_FOUND', message: `bullet ${input.id} not found` })
    const reconcile = await ctx.runtime.reprocessBullet(input.id)
    return { bullet, reconcile }
  }),

  /** Soft-delete a bullet per the chosen mode: cancel | cascade | keep (§4.6). */
  delete: publicProcedure.input(bulletDeleteInput).mutation(({ ctx, input }) => {
    // Verify existence for ALL modes so delete-on-missing-id is consistently NOT_FOUND (matching
    // get/update). softDelete throws NOT_FOUND for keep/cascade but treats 'cancel' as an
    // unconditional no-op, so without this an unknown id would silently succeed under 'cancel'.
    if (!getBulletById(ctx.db, input.id))
      throw new TRPCError({ code: 'NOT_FOUND', message: `bullet ${input.id} not found` })
    return softDelete(ctx.db, input.id, input.mode)
  }),
})
