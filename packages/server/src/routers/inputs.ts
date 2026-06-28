/**
 * Zod input schemas for the procedures. These shape the CLIENT-supplied fields only: the
 * procedures inject `owner_id` (from the context) and `source_bullet_id: null` (manual creation),
 * then the @bullet/db repositories RE-VALIDATE the full insert against the core schema. So these
 * schemas reuse the core entity schemas (single source of truth for field rules) with the
 * server-managed/provenance/owner fields removed.
 *
 * Plain `z.object` core insert schemas (task/activity/tracker_entry) compose via `.omit`/`.partial`.
 * `trackerInsertSchema` is a refined `ZodEffects`, so its client view is rebuilt from the same
 * exported building blocks (`trackerInputTypeSchema` + `trackerConfigSchema`, whose refinements
 * still fire). The matching `input_type`↔`config` coherence is re-checked by the repository.
 */

import {
  activityInsertSchema,
  nonEmptyString,
  suggestionPayloadSchema,
  taskInsertSchema,
  trackerConfigSchema,
  trackerEntryInsertSchema,
  trackerInputTypeSchema,
} from '@bullet/core'
import { z } from 'zod'

/** Fields the server injects/owns — never accepted from the client on a create. */
const serverOwnedCreateFields = {
  id: true,
  owner_id: true,
  source_bullet_id: true,
  created_at: true,
  updated_at: true,
  state: true,
} as const

/** `{ id }` — the canonical "address one row" input. */
export const byIdInput = z.object({ id: z.string().uuid() })

// --- Bullets --------------------------------------------------------------------------------

export const bulletCreateInput = z.object({ text: nonEmptyString() })
export const bulletUpdateInput = z.object({ id: z.string().uuid(), text: nonEmptyString() })
export const bulletDeleteInput = z.object({
  id: z.string().uuid(),
  mode: z.enum(['cancel', 'cascade', 'keep']),
})

// --- Suggestions ----------------------------------------------------------------------------

export const suggestionEditInput = z.object({
  id: z.string().uuid(),
  payload: suggestionPayloadSchema,
})

// --- Tasks ----------------------------------------------------------------------------------

export const taskCreateInput = taskInsertSchema.omit(serverOwnedCreateFields)
export const taskUpdateInput = taskInsertSchema
  .omit(serverOwnedCreateFields)
  .partial()
  .extend({ id: z.string().uuid() })

// --- Trackers (refined ZodEffects → rebuild the client view) --------------------------------

export const trackerCreateInput = z.object({
  name: nonEmptyString(),
  input_type: trackerInputTypeSchema,
  config: trackerConfigSchema,
})
export const trackerUpdateInput = z
  .object({
    name: nonEmptyString().optional(),
    input_type: trackerInputTypeSchema.optional(),
    config: trackerConfigSchema.optional(),
  })
  .extend({ id: z.string().uuid() })

// --- Tracker entries ------------------------------------------------------------------------

export const trackerEntryCreateInput = trackerEntryInsertSchema.omit(serverOwnedCreateFields)
export const trackerEntryUpdateInput = trackerEntryInsertSchema
  .omit({ ...serverOwnedCreateFields, tracker_id: true })
  .partial()
  .extend({ id: z.string().uuid() })

// --- Activities -----------------------------------------------------------------------------

export const activityCreateInput = activityInsertSchema.omit(serverOwnedCreateFields)
export const activityUpdateInput = activityInsertSchema
  .omit(serverOwnedCreateFields)
  .partial()
  .extend({ id: z.string().uuid() })
