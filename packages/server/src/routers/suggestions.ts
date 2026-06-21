/**
 * suggestions router — the user-confirmation surface for the extraction envelope. Listing the
 * owner's pending suggestions and resolving them (accept / reject / edit) are thin wrappers over
 * the @bullet/db apply engine, which owns the status transitions and the apply/commit logic.
 */

import {
  acceptSuggestion,
  editSuggestion,
  listSuggestionsByStatus,
  rejectSuggestion,
} from '@bullet/db'
import { publicProcedure, router } from '../trpc'
import { byIdInput, suggestionEditInput } from './inputs'

export const suggestionsRouter = router({
  /** The owner's active, pending suggestions awaiting review. */
  listPending: publicProcedure.query(({ ctx }) =>
    listSuggestionsByStatus(ctx.db, ctx.ownerId, 'pending'),
  ),

  /** Accept a suggestion: apply it and mark it accepted. Returns the suggestion + applied entity. */
  accept: publicProcedure
    .input(byIdInput)
    .mutation(({ ctx, input }) => acceptSuggestion(ctx.db, input.id)),

  /** Reject a suggestion: mark it rejected, applying nothing. */
  reject: publicProcedure
    .input(byIdInput)
    .mutation(({ ctx, input }) => rejectSuggestion(ctx.db, input.id)),

  /** Accept-with-modifications: validate + persist the edited payload, then apply it (§4.7). */
  edit: publicProcedure
    .input(suggestionEditInput)
    .mutation(({ ctx, input }) => editSuggestion(ctx.db, input.id, input.payload)),
})
