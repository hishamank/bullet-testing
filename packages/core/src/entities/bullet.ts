import { z } from 'zod'
import { recordStateSchema } from '../enums'
import { nonEmptyString, timestampMs, uuid } from '../primitives'

/**
 * Bullet — the atomic input unit; the raw text the user typed + timestamp. The stream of
 * bullets IS the journal and is the provenance anchor for everything, so a Bullet has NO
 * `source_bullet_id` of its own.
 */
export const bulletSelectSchema = z.object({
  id: uuid(),
  owner_id: uuid(),
  text: nonEmptyString(),
  created_at: timestampMs(),
  updated_at: timestampMs(),
  state: recordStateSchema,
})
export type Bullet = z.infer<typeof bulletSelectSchema>

export const bulletInsertSchema = z.object({
  id: uuid().optional(),
  owner_id: uuid(),
  text: nonEmptyString(),
  created_at: timestampMs().optional(),
  updated_at: timestampMs().optional(),
  state: recordStateSchema.optional(),
})
export type BulletInsert = z.infer<typeof bulletInsertSchema>
