import { z } from 'zod'
import {
  ownedTimestampedStateFields,
  ownedTimestampedStateInsertFields,
  sourceBulletIdNullable,
} from '../base'
import { timestampMs, uuid } from '../primitives'

/**
 * The set of value types a TrackerEntry can hold. Which one is valid depends on the parent
 * Tracker's `input_type` (number → number, scale → number, boolean → boolean, text → string,
 * single_select → string, multi_select → string[]). That cross-entity check belongs to the
 * apply/resolve layer (it needs the tracker); here we accept the structural union.
 */
export const trackerEntryValueSchema = z.union([
  z.number(),
  z.string(),
  z.boolean(),
  z.array(z.string()),
])
export type TrackerEntryValue = z.infer<typeof trackerEntryValueSchema>

/**
 * TrackerEntry — a value logged against a Tracker at a point in time.
 */
export const trackerEntrySelectSchema = z.object({
  ...ownedTimestampedStateFields,
  ...sourceBulletIdNullable,
  tracker_id: uuid(),
  value: trackerEntryValueSchema,
  logged_at: timestampMs(),
})
export type TrackerEntry = z.infer<typeof trackerEntrySelectSchema>

export const trackerEntryInsertSchema = z.object({
  ...ownedTimestampedStateInsertFields,
  ...sourceBulletIdNullable,
  tracker_id: uuid(),
  value: trackerEntryValueSchema,
  logged_at: timestampMs(),
})
export type TrackerEntryInsert = z.infer<typeof trackerEntryInsertSchema>
