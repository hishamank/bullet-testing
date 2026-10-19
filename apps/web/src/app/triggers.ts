/**
 * Browser edge: what makes the web app sync, and save its local copy.
 *
 *  - on load (when paired)         → sync
 *  - the tab comes to the front    → sync (and the gentle schedule starts); hidden stops it
 *  - the window gets focus         → sync
 *  - the network comes back        → sync
 *  - the tab is hidden or closing  → save the local copy now, and close the Undo windows
 *  - closing with unsaved changes  → the browser asks first (`beforeunload`)
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
  rt: Pick<Runtime, 'sync' | 'flush' | 'notify' | 'dirty' | 'inbox'>,
  page: PageLike = { window, document },
): () => void {
  const { window: win, document: doc } = page
  const syncNow = () => void rt.sync.syncNow()

  const onVisibility = () => {
    const visible = doc.visibilityState === 'visible'
    rt.sync.setForeground(visible)
    if (visible) syncNow()
    else {
      // Like the phone going to the background: nobody can tap Undo now, so send what was decided.
      rt.inbox.flushDecisions()
      void rt.flush()
    }
  }
  const onPageHide = () => void rt.flush()
  const onOffline = () => rt.notify()
  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (!rt.dirty()) return
    e.preventDefault()
    e.returnValue = ''
  }

  doc.addEventListener('visibilitychange', onVisibility)
  win.addEventListener('focus', syncNow)
  win.addEventListener('online', syncNow)
  win.addEventListener('offline', onOffline)
  win.addEventListener('pagehide', onPageHide)
  win.addEventListener('beforeunload', onBeforeUnload as EventListener)
  syncNow()
  return () => {
    doc.removeEventListener('visibilitychange', onVisibility)
    win.removeEventListener('focus', syncNow)
    win.removeEventListener('online', syncNow)
    win.removeEventListener('offline', onOffline)
    win.removeEventListener('pagehide', onPageHide)
    win.removeEventListener('beforeunload', onBeforeUnload as EventListener)
  }
}
