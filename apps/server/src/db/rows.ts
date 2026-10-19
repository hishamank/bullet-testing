/** Row ↔ contract mapping: what a database row looks like on the wire (`@bullet/core` shapes). */

import {
  type AudioAttachment,
  CONNECTION_RULES,
  type NoticedCard,
  type Suggestion,
  type SyncedBullet,
  type SyncedThought,
  type Theme,
  type ThemeThought,
  type ThoughtLink,
} from '@bullet/core'
import type {
  audioAttachments,
  bullets,
  noticedCards,
  suggestions,
  themes,
  themeThoughts,
  thoughtLinks,
  thoughts,
} from './schema'

type BulletRow = typeof bullets.$inferSelect
type SuggestionRow = typeof suggestions.$inferSelect

export function toSyncedBullet(row: BulletRow): SyncedBullet {
  return {
    id: row.id,
    owner_id: row.owner_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    state: row.state,
    text: row.text,
    captured_at: row.captured_at,
    timezone: row.timezone,
    source: row.source,
    text_edited_by_user: row.text_edited_by_user,
    text_from_draft: row.text_from_draft,
    answers_question_id: row.answers_question_id,
    resolves_thought_id: row.resolves_thought_id,
    processing: {
      status: row.proc_status,
      attempts: row.proc_attempts,
      error:
        row.proc_error_code === null
          ? null
          : { code: row.proc_error_code, message: row.proc_error_message ?? '' },
      next_retry_at: row.proc_next_retry_at,
      updated_at: row.proc_updated_at,
    },
  }
}

export function toSuggestion(row: SuggestionRow): Suggestion {
  const { applied_before, applied_after, ...rest } = row
  void applied_before
  void applied_after
  return rest
}

/** The server's storage key is internal: not part of the contract. */
export function toAudioAttachment(row: typeof audioAttachments.$inferSelect): AudioAttachment {
  const { storage_key, ...rest } = row
  void storage_key
  return rest
}

/**
 * A thought for the phone: `sensitive` is server-only and never leaves the home server, and its
 * named entities are only for linking.
 */
export function toThought(row: typeof thoughts.$inferSelect): SyncedThought {
  const { span_start, span_end, sensitive, entities, ...rest } = row
  void sensitive
  void entities
  return {
    ...rest,
    span: span_start === null || span_end === null ? null : { start: span_start, end: span_end },
  }
}

/** Sensitive thoughts never leave their own capture: a link touching one is sent as deleted. */
export function toThoughtLink(
  row: typeof thoughtLinks.$inferSelect,
  sensitive: ReadonlySet<string>,
): ThoughtLink {
  const hidden = sensitive.has(row.a_thought_id) || sensitive.has(row.b_thought_id)
  return {
    id: row.id,
    owner_id: row.owner_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    state: hidden ? 'deleted' : row.state,
    a_thought_id: row.a_thought_id,
    a_bullet_id: row.a_bullet_id,
    b_thought_id: row.b_thought_id,
    b_bullet_id: row.b_bullet_id,
    type: row.type,
  }
}

/** A theme made half or more of sensitive thoughts is not surfaced at all (sent as deleted). */
export const isHiddenTheme = (row: Pick<typeof themes.$inferSelect, 'sensitive_share'>) =>
  row.sensitive_share >= CONNECTION_RULES.sensitiveShare

export function toTheme(row: typeof themes.$inferSelect): Theme {
  const hidden = isHiddenTheme(row)
  return {
    id: row.id,
    owner_id: row.owner_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    state: hidden ? 'deleted' : row.state,
    name: hidden ? null : (row.user_name ?? row.model_name),
    named_by_user: row.user_name !== null,
    status: row.status,
    merged_into_theme_id: row.merged_into_theme_id,
    thought_count: row.thought_count,
    day_count: row.day_count,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
  }
}

export function toThemeThought(
  row: typeof themeThoughts.$inferSelect,
  hidden: boolean,
): ThemeThought {
  return {
    id: row.id,
    owner_id: row.owner_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    state: hidden ? 'deleted' : row.state,
    theme_id: row.theme_id,
    thought_id: row.thought_id,
    bullet_id: row.bullet_id,
  }
}

/** A card never quotes a sensitive thought; one with nothing left to quote is sent as deleted. */
export function toNoticedCard(
  row: typeof noticedCards.$inferSelect,
  sensitive: ReadonlySet<string>,
  themeHidden: boolean,
): NoticedCard {
  const quotes = row.quotes.filter((q) => !sensitive.has(q.thought_id))
  const hidden = themeHidden || quotes.length === 0
  return {
    id: row.id,
    owner_id: row.owner_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    state: hidden ? 'deleted' : row.state,
    theme_id: row.theme_id,
    headline: row.headline,
    quotes,
    count: row.count,
    days: row.days,
    status: row.status,
    opened_at: row.opened_at,
    resolved_at: row.resolved_at,
  }
}
