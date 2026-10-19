import { z } from 'zod'
import { ownedTimestampedStateFields } from '../base'
import { nonEmptyString, timestampMs, uuid } from '../primitives'
import type { ThoughtKind } from './thought'

/**
 * Connections (slice 3): links between thoughts of different captures, recurring themes, and the
 * Noticed cards that point a theme out. Everything here is quiet: never in the Inbox badge, never
 * notified, always in the user's own words, and every link, theme and card can be corrected
 * ("Not related", "Not a theme", rename, merge). Corrections are remembered: nothing re-creates
 * what the user took back, not nightly runs, edits or re-processing.
 *
 * Sensitive thoughts (server-only flag) are embedded and linked on the server, but never leave
 * their own capture: links touching one are not pulled, Noticed never quotes one, and a theme
 * made half or more of them is not pulled at all (no card, no name).
 */

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * How two thoughts are connected:
 *  - same_entity — the same person, place or project ("Karim", "the Hamra flat").
 *  - same_topic  — about the same thing.
 *  - answers     — the later thought answers an earlier open loop (`to_check` / `question`).
 *  - revisits    — the later thought asks again, or restates, an earlier question or idea.
 */
export const linkTypeSchema = z.enum(['same_entity', 'same_topic', 'answers', 'revisits'])
export type LinkType = z.infer<typeof linkTypeSchema>

/**
 * A link as the phone sees it: undirected, between two thoughts of different captures (`a` is
 * the earlier capture). Show it under "Related" on either capture. Deleted by "Not related"
 * (`link.veto`), which also stops it from ever coming back.
 */
export const thoughtLinkSelectSchema = z.object({
  ...ownedTimestampedStateFields,
  a_thought_id: uuid(),
  a_bullet_id: uuid(),
  b_thought_id: uuid(),
  b_bullet_id: uuid(),
  type: linkTypeSchema,
})
export type ThoughtLink = z.infer<typeof thoughtLinkSelectSchema>

/**
 * Theme status:
 *  - active  — recurring now (it met the theme rules within the last 30 days).
 *  - dormant — it did, but not any more (or it fell outside the 8 most active); it may return.
 *  - retired — "Not a theme" (never re-created from the same thoughts), or merged into another
 *              (`merged_into_theme_id`; later matches fold into that one).
 */
export const themeStatusSchema = z.enum(['active', 'dormant', 'retired'])
export type ThemeStatus = z.infer<typeof themeStatusSchema>

export const themeSelectSchema = z.object({
  ...ownedTimestampedStateFields,
  /**
   * What to call it: the user's name (`theme.rename`) or else a short name the nightly model made
   * from the user's own words; null until it has one.
   */
  name: nonEmptyString().nullable(),
  /** True when `name` is the user's. */
  named_by_user: z.boolean(),
  status: themeStatusSchema,
  /** Merged themes: the theme it now lives in. */
  merged_into_theme_id: uuid().nullable(),
  /** Thoughts in it over the last 30 days, and over how many days they came up. */
  thought_count: z.number().int().nonnegative(),
  day_count: z.number().int().nonnegative(),
  first_seen_at: timestampMs().nullable(),
  last_seen_at: timestampMs().nullable(),
})
export type Theme = z.infer<typeof themeSelectSchema>

/** A thought belonging to a theme (the Stream's "again" dot). */
export const themeThoughtSelectSchema = z.object({
  ...ownedTimestampedStateFields,
  theme_id: uuid(),
  thought_id: uuid(),
  bullet_id: uuid(),
})
export type ThemeThought = z.infer<typeof themeThoughtSelectSchema>

/**
 * A Noticed card's status: `new` (not opened yet), `opened`, `dismissed`, or `retired` (unopened
 * for 14 days, or its theme was retired or merged away).
 */
export const noticedStatusSchema = z.enum(['new', 'opened', 'dismissed', 'retired'])
export type NoticedStatus = z.infer<typeof noticedStatusSchema>

/** One of a card's quotes: the user's words, opening its capture. */
export const noticedQuoteSchema = z.object({
  thought_id: uuid(),
  bullet_id: uuid(),
  text: nonEmptyString(),
})
export type NoticedQuote = z.infer<typeof noticedQuoteSchema>

export const noticedCardSelectSchema = z.object({
  ...ownedTimestampedStateFields,
  theme_id: uuid(),
  /** "«quote» · came up N times in M days", ready to show. */
  headline: nonEmptyString(),
  /** Up to 3 quotes, newest first, each from its own capture where possible. */
  quotes: z.array(noticedQuoteSchema).max(3),
  /** N and M of the headline. */
  count: z.number().int().positive(),
  days: z.number().int().positive(),
  status: noticedStatusSchema,
  opened_at: timestampMs().nullable(),
  resolved_at: timestampMs().nullable(),
})
export type NoticedCard = z.infer<typeof noticedCardSelectSchema>

/**
 * The rules and limits:
 *  - a theme is ≥ `minThoughts` linked thoughts over ≥ `minDays` distinct days from ≥
 *    `minCaptures` captures, within a rolling `windowMs`;
 *  - at most `maxActiveThemes` active themes;
 *  - a Noticed card at most once per theme per `cardEveryMs`, at most `maxCardsPerDay` in any 24
 *    hours, and an unopened card retires after `cardRetireMs`;
 *  - a theme whose thoughts are `sensitiveShare` or more sensitive gets no card and no name;
 *  - at most `maxLinksPerThought` links per thought, from its `candidates` nearest thoughts.
 */
export const CONNECTION_RULES = {
  minThoughts: 4,
  minDays: 3,
  minCaptures: 2,
  windowMs: 30 * DAY_MS,
  maxActiveThemes: 8,
  cardEveryMs: 14 * DAY_MS,
  maxCardsPerDay: 2,
  cardRetireMs: 14 * DAY_MS,
  sensitiveShare: 0.5,
  maxLinksPerThought: 5,
  candidates: 10,
} as const

/**
 * The thought kinds a connection question may compare (both thoughts must be one of these):
 * worries, things to check, self-questions and ideas.
 */
export const CONNECTION_THOUGHT_KINDS = [
  'worry',
  'to_check',
  'question',
  'idea',
] as const satisfies readonly ThoughtKind[]

/**
 * Words Noticed copy never uses: it observes, in the user's words, and never interprets
 * ("you seem", "you tend to", "a pattern", "stress"). Checked on everything the app writes on a
 * card (the template and the theme names the model proposes); the quotes are the user's own.
 */
export const NOTICED_DENYLIST = [
  'seem',
  'tend',
  'should',
  'pattern',
  'stress',
  'anxious',
  'always',
  'never',
] as const

/** True when `text` uses a denied word (any form: "seems", "tends", "stressed", "patterns"). */
export function usesDeniedWord(text: string): boolean {
  const t = text.normalize('NFKD').toLowerCase()
  return NOTICED_DENYLIST.some((w) => new RegExp(`(?<![\\p{L}])${w}`, 'u').test(t))
}

/** "«quote» · came up N times in M days" (the counts are always ≥ 1). */
export function noticedHeadline(quote: string, count: number, days: number): string {
  const times = count === 1 ? 'once' : `${count} times`
  const span = days === 1 ? '1 day' : `${days} days`
  return `«${quote}» · came up ${times} in ${span}`
}
