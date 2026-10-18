import { z } from 'zod'
import {
  ownedTimestampedStateFields,
  ownedTimestampedStateInsertFields,
  sourceBulletIdNullable,
} from '../base'
import { timestampMs, uuid } from '../primitives'
import type { TrackerConfig } from './tracker'

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

/** Does `value` fit the tracker's input type and bounds? (Shared by the server and the phone.) */
export function entryValueFits(value: TrackerEntryValue, config: TrackerConfig): boolean {
  switch (config.input_type) {
    case 'scale':
      return typeof value === 'number' && value >= config.min && value <= config.max
    case 'number':
      return (
        typeof value === 'number' &&
        (config.min === undefined || value >= config.min) &&
        (config.max === undefined || value <= config.max)
      )
    case 'boolean':
      return typeof value === 'boolean'
    case 'text':
      return typeof value === 'string'
    case 'single_select':
      return typeof value === 'string' && config.options.includes(value)
    case 'multi_select':
      return Array.isArray(value) && value.every((v) => config.options.includes(v))
    default:
      return false
  }
}

/**
 * TrackerEntry — a value logged against a Tracker at a point in time.
 */
export const trackerEntrySelectSchema = z.object({
  ...ownedTimestampedStateFields,
  ...sourceBulletIdNullable,
  tracker_id: uuid(),
  value: trackerEntryValueSchema,
  logged_at: timestampMs(),
  /**
   * When the user last changed this by hand (a manual edit or delete); null if never. Undo of a
   * suggestion applied before then is refused, and reprocessing never overwrites it.
   */
  user_edited_at: timestampMs().nullable().default(null),
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
