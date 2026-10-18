import { z } from 'zod'
import { ownedTimestampedStateFields, ownedTimestampedStateInsertFields } from '../base'
import { bulletSourceSchema } from '../enums'
import { bulletProcessingSchema } from '../processing'
import { ianaTimezone, nonEmptyString, timestampMs, uuid } from '../primitives'

/**
 * Bullet — called a **Capture** in the product: what the user typed or said in one go (with its
 * audio if voice), kept forever. A capture is split into Thoughts (thought.ts), from which things
 * (tasks, events, …) are extracted. `bullet` remains the name in code and on the wire (renaming
 * would break the stable contract for no behavioural gain); `Capture` is an alias.
 *
 * Bullet — the atomic input unit; the raw text the user typed (or dictated) + when. The stream of
 * bullets IS the journal and is the provenance anchor for everything, so a Bullet has NO
 * `source_bullet_id` of its own.
 *
 *  - `captured_at` — client clock at capture (epoch ms). Relative dates ("tomorrow") and record
 *    timestamps resolve against this, never against processing time.
 *  - `timezone`    — the device's IANA zone at capture, so "Thursday 3pm" means local 3pm.
 *  - `source`      — typed or voice. A voice bullet's `text` is its transcript: first the device
 *    draft, then the server's (Whisper) transcript — unless the user edited it.
 *  - `text_edited_by_user` — true once the user changed the text by hand (before sending a voice
 *    draft, or any later edit). Server transcription then never overwrites the text.
 *  - `processing`  — where the bullet is in the capture loop (see processing.ts).
 *
 * `id` is minted on the client (UUID v4) so sync is idempotent.
 */
const bulletContentFields = {
  text: nonEmptyString(),
  captured_at: timestampMs(),
  timezone: ianaTimezone(),
  source: bulletSourceSchema,
  text_edited_by_user: z.boolean(),
  /** Set when this capture answers a clarifying Question. */
  answers_question_id: uuid().nullable(),
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
  text_edited_by_user: z.boolean().default(false),
  answers_question_id: uuid().nullable().default(null),
})
export type BulletInsert = z.infer<typeof bulletInsertSchema>

/** The product name for a bullet. */
export type Capture = Bullet
