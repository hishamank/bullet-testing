import { z } from 'zod'
import {
  ownedTimestampedStateFields,
  ownedTimestampedStateInsertFields,
  sourceBulletIdNullable,
} from '../base'
import { nonEmptyString, timestampMs } from '../primitives'

/**
 * Event — something that HAPPENS to the user at a time (a dentist appointment, dinner at 8).
 * Distinct from a Task (something the user DOES). No recurrence yet.
 *
 *  - `starts_at` / `ends_at` are epoch ms. `ends_at` is optional and never before `starts_at`.
 *  - `all_day` events have `starts_at` at local midnight of that day (in the capturing bullet's
 *    time zone); `ends_at` is null or local midnight of the last day.
 */
const eventFields = {
  title: nonEmptyString(),
  starts_at: timestampMs(),
  ends_at: timestampMs().nullable(),
  all_day: z.boolean(),
  location: z.string().nullable(),
  notes: z.string().nullable(),
} as const

const endsAfterStart = (e: { starts_at: number; ends_at: number | null }, ctx: z.RefinementCtx) => {
  if (e.ends_at !== null && e.ends_at < e.starts_at) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'ends_at must not be before starts_at',
      path: ['ends_at'],
    })
  }
}

export const eventSelectSchema = z
  .object({ ...ownedTimestampedStateFields, ...sourceBulletIdNullable, ...eventFields })
  .superRefine(endsAfterStart)
export type Event = z.infer<typeof eventSelectSchema>

export const eventInsertSchema = z
  .object({
    ...ownedTimestampedStateInsertFields,
    ...sourceBulletIdNullable,
    ...eventFields,
    all_day: z.boolean().default(false),
  })
  .superRefine(endsAfterStart)
export type EventInsert = z.infer<typeof eventInsertSchema>
