import { z } from 'zod'
import { ownedTimestampedStateFields, ownedTimestampedStateInsertFields } from '../base'
import { bulletSourceSchema } from '../enums'
import { bulletProcessingSchema } from '../processing'
import { ianaTimezone, nonEmptyString, timestampMs } from '../primitives'

/**
 * Bullet — the atomic input unit; the raw text the user typed (or dictated) + when. The stream of
 * bullets IS the journal and is the provenance anchor for everything, so a Bullet has NO
 * `source_bullet_id` of its own.
 *
 *  - `captured_at` — client clock at capture (epoch ms). Relative dates ("tomorrow") and record
 *    timestamps resolve against this, never against processing time.
 *  - `timezone`    — the device's IANA zone at capture, so "Thursday 3pm" means local 3pm.
 *  - `source`      — typed or voice (voice carries the transcript as `text`).
 *  - `processing`  — where the bullet is in the capture loop (see processing.ts).
 *
 * `id` is minted on the client (UUID v4) so sync is idempotent.
 */
const bulletContentFields = {
  text: nonEmptyString(),
  captured_at: timestampMs(),
  timezone: ianaTimezone(),
  source: bulletSourceSchema,
} as const

export const bulletSelectSchema = z.object({
  ...ownedTimestampedStateFields,
  ...bulletContentFields,
  processing: bulletProcessingSchema,
})
export type Bullet = z.infer<typeof bulletSelectSchema>

export const bulletInsertSchema = z.object({
  ...ownedTimestampedStateInsertFields,
  ...bulletContentFields,
  source: bulletSourceSchema.default('text'),
})
export type BulletInsert = z.infer<typeof bulletInsertSchema>
