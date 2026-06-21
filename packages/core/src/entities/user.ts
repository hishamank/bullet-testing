import { z } from 'zod'
import { timestampMs, uuid } from '../primitives'

/**
 * User — the owner root. Minimal by design: it is the entity every `owner_id` points at.
 * Has NO `owner_id` (it IS the owner) and NO `source_bullet_id` (it is not extracted).
 */
export const userSelectSchema = z.object({
  id: uuid(),
  name: z.string().nullable(),
  created_at: timestampMs(),
  updated_at: timestampMs(),
})
export type User = z.infer<typeof userSelectSchema>

export const userInsertSchema = z.object({
  id: uuid().optional(),
  name: z.string().nullable(),
  created_at: timestampMs().optional(),
  updated_at: timestampMs().optional(),
})
export type UserInsert = z.infer<typeof userInsertSchema>
