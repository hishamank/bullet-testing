/** The Inbox view for the screen: the live local query plus the open Undo windows. */

import { useMemo } from 'react'
import { useLocalQuery, useStore } from '@/hooks'
import { deviceDeps } from '../../sync/runtime'
import { undoStore } from './actions'
import { buildInbox, type InboxView } from './model'
import { loadInboxRows } from './model'

export function useInbox(): InboxView {
  const undo = useStore(undoStore)
  const heldIds = undo.map((e) => e.suggestionId)
  const key = heldIds.join(',')
  const rows = useLocalQuery(
    (db) => loadInboxRows(db, { now: Date.now(), timezone: deviceDeps.timezone(), heldIds }),
    key,
  )
  return useMemo(() => buildInbox(rows, undo), [rows, undo])
}
