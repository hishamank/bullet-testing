/**
 * A tiny hash router, pure: `parseHash` and `formatHash` turn the location into a `Route` and back.
 * The main view is the path (`#/journal/loops`, `#/inbox`); whatever is open in the side panel is
 * `?panel=` (`capture:<id>`, `edit:<suggestion id>`, …). The panel lives in the URL so the browser's
 * Back button closes it, which is what a full-screen panel on a phone-width window needs.
 */

export type MainView = 'capture' | 'journal' | 'inbox'
export type JournalTab = 'stream' | 'loops' | 'plans' | 'trackers'

export const JOURNAL_TABS: readonly { id: JournalTab; label: string }[] = [
  { id: 'stream', label: 'Stream' },
  { id: 'loops', label: 'Open loops' },
  { id: 'plans', label: 'Plans' },
  { id: 'trackers', label: 'Trackers' },
]

export type Panel =
  | { kind: 'capture'; id: string; write?: boolean }
  | { kind: 'edit'; id: string }
  | { kind: 'answer'; target: 'question' | 'thought'; id: string }
  | { kind: 'theme'; id: string }
  | { kind: 'merge'; id: string }
  | { kind: 'plan'; id: string }
  | { kind: 'tracker'; id: string }
  | { kind: 'activity'; name: string }
  | { kind: 'pick' }
  | { kind: 'settings' }

export interface Route {
  view: MainView
  tab: JournalTab
  panel: Panel | null
}

export const defaultRoute: Route = { view: 'capture', tab: 'stream', panel: null }

const enc = encodeURIComponent
const dec = (s: string): string => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

export function formatPanel(p: Panel): string {
  switch (p.kind) {
    case 'capture':
      return p.write ? `capture:${enc(p.id)}:write` : `capture:${enc(p.id)}`
    case 'answer':
      return `answer:${p.target}:${enc(p.id)}`
    case 'activity':
      return `activity:${enc(p.name)}`
    case 'pick':
    case 'settings':
      return p.kind
    default:
      return `${p.kind}:${enc(p.id)}`
  }
}

export function parsePanel(text: string | null): Panel | null {
  if (!text) return null
  const [kind = '', a = '', b = ''] = text.split(':')
  const id = dec(a)
  switch (kind) {
    case 'capture':
      return id ? { kind, id, ...(b === 'write' ? { write: true } : {}) } : null
    case 'edit':
    case 'theme':
    case 'merge':
    case 'plan':
    case 'tracker':
      return id ? { kind, id } : null
    case 'answer':
      return (a === 'question' || a === 'thought') && b ? { kind, target: a, id: dec(b) } : null
    case 'activity':
      return id ? { kind, name: id } : null
    case 'pick':
    case 'settings':
      return { kind }
    default:
      return null
  }
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '')
  const [path = '', query = ''] = raw.split('?')
  const parts = path.split('/').filter(Boolean)
  // The panel's own parts are percent-encoded (they may contain ':'), so read it undecoded.
  const panel = parsePanel(/(?:^|&)panel=([^&]*)/.exec(query)?.[1] ?? null)
  const view = parts[0]
  if (view === 'inbox') return { ...defaultRoute, view: 'inbox', panel }
  if (view === 'journal') {
    const tab = JOURNAL_TABS.find((t) => t.id === parts[1])?.id ?? 'stream'
    return { view: 'journal', tab, panel }
  }
  return { ...defaultRoute, view: 'capture', panel }
}

export function formatHash(route: Route): string {
  const path =
    route.view === 'journal'
      ? `/journal/${route.tab}`
      : route.view === 'inbox'
        ? '/inbox'
        : '/capture'
  return route.panel ? `#${path}?panel=${formatPanel(route.panel)}` : `#${path}`
}

/** The same page with another panel open (or none). */
export function withPanel(route: Route, panel: Panel | null): Route {
  return { ...route, panel }
}

/** Go to a main view, closing any panel. */
export function toView(view: MainView, tab: JournalTab = 'stream'): Route {
  return { view, tab, panel: null }
}
