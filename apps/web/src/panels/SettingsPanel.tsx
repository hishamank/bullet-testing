/**
 * Settings, kept minimal: the home server's status, what waits on this device, Sync now, Reset the
 * local copy and Unpair. The local copy is only a cache of the home server; resetting or unpairing
 * wipes it, and the next full pull rebuilds it. Captures the server has not confirmed are lost
 * with it, so those buttons say so first.
 */

import { serverStatusLine } from '@bullet/client'
import { useState } from 'react'
import { useCaptureCounts, useNow, useRuntime, useSyncStatus } from '../app/hooks'
import { pendingLine } from '../app/status'
import { Button } from '../ui/primitives'
import { PanelFrame } from './PanelFrame'

type Confirm = 'reset' | 'unpair' | null

export function SettingsPanel() {
  const rt = useRuntime()
  const sync = useSyncStatus()
  const counts = useCaptureCounts()
  const now = useNow(30_000)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [busy, setBusy] = useState(false)
  const unsent = counts.outbox
  const status = serverStatusLine({
    paired: sync.paired,
    baseUrl: rt.server()?.baseUrl ?? null,
    reachability: sync.reachability,
    cannotReach: sync.cannotReachServer,
    lastSyncedAt: sync.lastSyncedAt,
    now,
  })

  async function run(kind: Exclude<Confirm, null>) {
    setBusy(true)
    try {
      if (kind === 'unpair') await rt.unpair()
      else await rt.resetLocalCopy()
    } finally {
      setBusy(false)
      setConfirm(null)
    }
  }

  return (
    <PanelFrame title="Settings">
      <section className="stack-sm" aria-label="Home server">
        <h3 className="section-title">Home server</h3>
        <p aria-live="polite">{status}</p>
        <p className="caption">{sync.indicator.detail}</p>
        <p className="caption">{pendingLine(counts.outbox)}</p>
        <div className="row">
          <Button onClick={() => void rt.sync.syncNow()}>Sync now</Button>
        </div>
      </section>
      <section className="stack-sm" aria-label="Local copy">
        <h3 className="section-title">This browser</h3>
        <p className="caption">
          Your journal is copied into this browser so it opens quickly. It is a cache of the home
          server and rebuilds from it.
        </p>
        {confirm ? (
          <div role="alertdialog" aria-labelledby="confirm-title" className="confirm">
            <h3 id="confirm-title">
              {confirm === 'unpair' ? 'Unpair this browser?' : 'Reset the local copy?'}
            </h3>
            <p>
              {confirm === 'unpair'
                ? 'The token is forgotten and the local copy is wiped.'
                : 'The local copy is wiped and read again from your home server.'}
            </p>
            {unsent > 0 ? (
              <p className="warn">
                {unsent === 1 ? '1 change hasn' : `${unsent} changes haven`}'t reached your home
                server yet and will be lost. Sync first if you can.
              </p>
            ) : null}
            <div className="row">
              <Button
                // oxlint-disable-next-line jsx-a11y/no-autofocus -- the safe choice gets focus
                autoFocus
                onClick={() => setConfirm(null)}
              >
                Cancel
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => void run(confirm)}>
                {confirm === 'unpair' ? 'Unpair' : 'Reset local copy'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="row">
            <Button onClick={() => setConfirm('reset')}>Reset local copy…</Button>
            <Button variant="danger" onClick={() => setConfirm('unpair')}>
              Unpair…
            </Button>
          </div>
        )}
      </section>
    </PanelFrame>
  )
}
