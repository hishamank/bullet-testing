/**
 * Browser edge: what makes the web app sync, and save its local copy.
 *
 *  - on load (when paired)         → sync
 *  - the tab comes to the front    → sync (and the gentle schedule starts); hidden stops it
 *  - the window gets focus         → sync
 *  - the network comes back        → sync
 *  - the tab is hidden or closing  → save the local copy now
 *  - after every local write       → sync (the runtime's `run`)
 *  - while visible                 → the controller's own schedule (soon / gently / backed off)
 *
 * The decisions are the shared `SyncController`'s; this only listens to the page.
 */

import type { Runtime } from './runtime'

/** The parts of `window` and `document` this listens to. */
export interface PageLike {
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>
  document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>
}

export function startTriggers(
  rt: Pick<Runtime, 'sync' | 'flush' | 'notify'>,
  page: PageLike = { window, document },
): () => void {
  const { window: win, document: doc } = page
  const syncNow = () => void rt.sync.syncNow()

  const onVisibility = () => {
    const visible = doc.visibilityState === 'visible'
    rt.sync.setForeground(visible)
    if (visible) syncNow()
    else void rt.flush()
  }
  const onPageHide = () => void rt.flush()
  const onOffline = () => rt.notify()

  doc.addEventListener('visibilitychange', onVisibility)
  win.addEventListener('focus', syncNow)
  win.addEventListener('online', syncNow)
  win.addEventListener('offline', onOffline)
  win.addEventListener('pagehide', onPageHide)
  syncNow()
  return () => {
    doc.removeEventListener('visibilitychange', onVisibility)
    win.removeEventListener('focus', syncNow)
    win.removeEventListener('online', syncNow)
    win.removeEventListener('offline', onOffline)
    win.removeEventListener('pagehide', onPageHide)
  }
}
