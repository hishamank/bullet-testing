import { z } from 'zod'
import { ownedTimestampedStateFields } from '../base'
import { nonEmptyString, timestampMs, uuid } from '../primitives'

/**
 * Thought — one separate thing the user said or typed within a capture ("capture → thoughts →
 * things"). A long voice ramble becomes many thoughts; a one-liner becomes one. EVERY thought is
 * kept, whether or not anything actionable was extracted from it: the user can empty their mind
 * knowing nothing is lost.
 *
 * `kind` is a classification, not a suggestion: thoughts need no review to be kept, but the user
 * can re-classify one (`kind_source: 'user'`; re-processing the capture never overrides it).
 *
 * Slice-1 kinds — all nine are explicit, so a list of thoughts can be shown/filtered by kind
 * without joining the things extracted from them:
 *  - worry     — something weighing on the user ("I'm anxious about the landlord").
 *  - to_check  — something to look into/verify ("check if the passport expires this year").
 *  - question  — an open question the user asked themself ("should I switch banks?").
 *  - idea      — an idea worth keeping.
 *  - note      — anything else worth keeping (a fact, a reflection, a memory).
 *  - task / event / tracker / activity — the thought is mainly one of these things; the actual
 *    Task/Event/TrackerEntry/Activity is extracted from it as a suggestion as before.
 *
 * Reflective questions about thoughts (slice 2) and connections/themes across captures (slice 3)
 * come later.
 */
export const thoughtKindSchema = z.enum([
  'worry',
  'to_check',
  'question',
  'idea',
  'note',
  'task',
  'event',
  'tracker',
  'activity',
])
export type ThoughtKind = z.infer<typeof thoughtKindSchema>

/**
 * Open loops: the kinds the user can mark resolved ("checked it", "answered it"), either directly
 * or with a note (a capture with `resolves_thought_id`).
 */
export const RESOLVABLE_THOUGHT_KINDS = [
  'to_check',
  'question',
] as const satisfies readonly ThoughtKind[]

/** Who set the kind: the engine's classification, or the user's re-classification (sticky). */
export const thoughtKindSourceSchema = z.enum(['engine', 'user'])

/** Character offsets `[start, end)` into the capture's text at the time it was segmented. */
export const textSpanSchema = z
  .object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() })
  .refine((s) => s.end >= s.start, { message: 'span end before start' })
export type TextSpan = z.infer<typeof textSpanSchema>

export const thoughtSelectSchema = z.object({
  ...ownedTimestampedStateFields,
  /** The capture it came from (provenance). */
  source_bullet_id: uuid(),
  /** Order within the capture, 0-based. */
  position: z.number().int().nonnegative(),
  /** The segment, lightly cleaned (filler words and false starts removed). */
  text: nonEmptyString(),
  /** Where it sits in the capture text; null when it could not be located (paraphrased). */
  span: textSpanSchema.nullable(),
  kind: thoughtKindSchema,
  kind_source: thoughtKindSourceSchema,
  /** When the user closed this open loop (`to_check` / `question`); null while open. */
  resolved_at: timestampMs().nullable().default(null),
  /** The capture that closed it "with a note", if any. */
  resolved_by_bullet_id: uuid().nullable().default(null),
})
export type Thought = z.infer<typeof thoughtSelectSchema>
