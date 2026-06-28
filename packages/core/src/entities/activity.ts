import { z } from 'zod'
import {
  ownedTimestampedStateFields,
  ownedTimestampedStateInsertFields,
  sourceBulletIdNullable,
} from '../base'
import { nonEmptyString, timestampMs, uuid } from '../primitives'

/**
 * Activity — a record: something the user DID (ran, smoked, meditated). May optionally link
 * to a Tracker (becomes a quantified entry); unlinked activities are kept and later feed
 * pattern detection.
 */
export const activitySelectSchema = z.object({
  ...ownedTimestampedStateFields,
  ...sourceBulletIdNullable,
  name: nonEmptyString(),
  occurred_at: timestampMs(),
  tracker_id: uuid().nullable(),
  notes: z.string().nullable(),
  quantity: z.number().nullable(),
  unit: z.string().nullable(),
})
export type Activity = z.infer<typeof activitySelectSchema>

export const activityInsertSchema = z.object({
  ...ownedTimestampedStateInsertFields,
  ...sourceBulletIdNullable,
  name: nonEmptyString(),
  occurred_at: timestampMs(),
  tracker_id: uuid().nullable(),
  notes: z.string().nullable(),
  quantity: z.number().nullable(),
  unit: z.string().nullable(),
})
export type ActivityInsert = z.infer<typeof activityInsertSchema>
