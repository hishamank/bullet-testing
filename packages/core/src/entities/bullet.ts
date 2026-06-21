import { z } from 'zod'
import { ownedTimestampedStateFields, ownedTimestampedStateInsertFields } from '../base'
import { nonEmptyString } from '../primitives'

/**
 * Bullet — the atomic input unit; the raw text the user typed + timestamp. The stream of
 * bullets IS the journal and is the provenance anchor for everything, so a Bullet has NO
 * `source_bullet_id` of its own. It carries the full owned + timestamped + state lifecycle,
 * composed from the shared base building block (like Task/Tracker/Activity/Suggestion).
 */
export const bulletSelectSchema = z.object({
  ...ownedTimestampedStateFields,
  text: nonEmptyString(),
})
export type Bullet = z.infer<typeof bulletSelectSchema>

export const bulletInsertSchema = z.object({
  ...ownedTimestampedStateInsertFields,
  text: nonEmptyString(),
})
export type BulletInsert = z.infer<typeof bulletInsertSchema>
