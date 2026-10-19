/** Where the app is (the hash route) and how to move: the context every screen reads. */

import { createContext, useCallback, useContext, useSyncExternalStore } from 'react'
import type { Actions } from './actions'
import { formatHash, type Panel, parseHash, type Route, withPanel } from './router'

const subscribe = (listener: () => void) => {
  window.addEventListener('hashchange', listener)
  return () => window.removeEventListener('hashchange', listener)
}

const hash = () => window.location.hash

/** The current route, kept current as the hash changes. */
export function useHashRoute(): Route {
  const h = useSyncExternalStore(subscribe, hash, () => '')
  return parseHash(h)
}

export interface Nav {
  route: Route
  go(route: Route, opts?: { replace?: boolean }): void
  openPanel(panel: Panel): void
  closePanel(): void
}

export function useNavValue(route: Route): Nav {
  const go = useCallback((next: Route, opts?: { replace?: boolean }) => {
    const state = { panel: next.panel !== null }
    const url = formatHash(next)
    if (opts?.replace) window.history.replaceState(state, '', url)
    else window.history.pushState(state, '', url)
    // `pushState` and `replaceState` don't fire `hashchange`; tell the subscribers.
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  }, [])
  return {
    route,
    go,
    // Opening one panel pushes one history entry; switching panels reuses it, so Back closes it.
    openPanel: (panel) => go(withPanel(route, panel), { replace: route.panel !== null }),
    closePanel: () => {
      const pushedByUs = (window.history.state as { panel?: boolean } | null)?.panel === true
      if (route.panel && pushedByUs && window.history.length > 1) window.history.back()
      else go(withPanel(route, null), { replace: true })
    },
  }
}

export const NavContext = createContext<Nav | null>(null)

export function useNav(): Nav {
  const nav = useContext(NavContext)
  if (!nav) throw new Error('NavContext is missing')
  return nav
}

export const ActionsContext = createContext<Actions | null>(null)

export function useActions(): Actions {
  const a = useContext(ActionsContext)
  if (!a) throw new Error('ActionsContext is missing')
  return a
}
