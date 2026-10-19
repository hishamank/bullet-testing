/** The Inbox view for the screen: the live local query plus the open Undo windows. */

import { useMemo } from 'react'
import { useLocalQuery, useNow, useStore } from '@/hooks'
import { deviceDeps } from '../../sync/runtime'
import { undoStore } from './actions'
import { buildInbox, type InboxView, loadInboxRows } from '@bullet/client'

export function useInbox(): InboxView {
  const undo = useStore(undoStore)
  // Re-read every minute too: a question back from "Later" makes the Inbox no longer empty.
  const now = useNow(60_000)
  const heldIds = undo.map((e) => e.suggestionId)
  const key = `${heldIds.join(',')}|${now}`
  const rows = useLocalQuery(
    (db) => loadInboxRows(db, { now, timezone: deviceDeps.timezone(), heldIds }),
    key,
  )
  return useMemo(() => buildInbox(rows, undo), [rows, undo])
}
