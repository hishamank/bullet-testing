/** The quiet line by the capture box: failed captures (with Retry), or what is being sorted. */

import {
  captureNotice,
  failedText,
  foundText,
  SORTING_TEXT,
  STILL_SORTING_TEXT,
  untranscribableText,
} from '@bullet/client'
import { useActions, useNav } from '../app/nav'
import { useCaptureCounts, useNow, useSyncStatus } from '../app/hooks'
import { onDeviceText } from '../app/status'
import { toView } from '../app/router'
import { Button } from '../ui/primitives'

export function StatusLine() {
  const nav = useNav()
  const actions = useActions()
  const counts = useCaptureCounts()
  const sync = useSyncStatus()
  // A static line that changes on its own only once ("Still sorting" after 5 minutes).
  const now = useNow(30_000)
  const notice = captureNotice({
    saved: false,
    failedCount: counts.failedIds.length,
    onPhoneCount: counts.onPhone,
    cannotReachServer: sync.cannotReachServer,
    unpaired: !sync.paired,
    untranscribableIds: counts.untranscribableIds,
    latest: counts.latest,
    now,
  })
  const openCapture = (id: string) => nav.openPanel({ kind: 'capture', id })
  switch (notice.kind) {
    case 'sorting':
      return <span className="status-text">{notice.slow ? STILL_SORTING_TEXT : SORTING_TEXT}</span>
    case 'found':
      return (
        <Button variant="quiet" onClick={() => openCapture(notice.bulletId)}>
          {foundText(notice.count)}
        </Button>
      )
    case 'failed':
      return (
        <span className="status-text">
          {failedText(notice.count)} ·{' '}
          <Button variant="text" onClick={() => actions.retryCaptures(counts.failedIds)}>
            Retry
          </Button>
        </span>
      )
    case 'untranscribable': {
      const one = notice.bulletId
      return (
        <Button
          variant="quiet"
          onClick={() => (one ? openCapture(one) : nav.go(toView('journal', 'stream')))}
        >
          {untranscribableText(notice.count)}
        </Button>
      )
    }
    case 'on_phone':
      return <span className="status-text">{onDeviceText(notice.count)}</span>
    default:
      return null
  }
}
