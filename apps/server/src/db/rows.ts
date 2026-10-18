/** Row ↔ contract mapping: what a database row looks like on the wire (`@bullet/core` shapes). */

import type { Suggestion, SyncedBullet } from '@bullet/core'
import type { bullets, suggestions } from './schema'

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
