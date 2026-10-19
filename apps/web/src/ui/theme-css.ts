/**
 * The night-calm palette as CSS custom properties, generated from the same tokens the phone uses
 * (`@bullet/client/theme`), so the two clients can never drift. Dark is the primary look; light
 * follows `prefers-color-scheme: light`. No fonts here: the page uses the system stacks only.
 */

import {
  dark,
  KIND_LABELS,
  kindStyle,
  light,
  type Palette,
  radius,
  space,
  type,
} from '@bullet/client/theme'
import type { ThoughtKind } from '@bullet/core'

const KINDS = Object.keys(KIND_LABELS) as ThoughtKind[]

/** One palette as custom properties (`color-scheme` included). */
export function paletteEntries(p: Palette): Record<string, string> {
  const out: Record<string, string> = {
    'color-scheme': p.scheme,
    '--bg': p.background,
    '--card': p.card,
    '--raised': p.raised,
    '--raised-strong': p.raisedStrong,
    '--hairline': p.hairline,
    '--note': p.note,
    '--text': p.text,
    '--text-2': p.textSecondary,
    '--muted': p.textMuted,
    '--soft': p.textSoft,
    '--accent': p.accent,
    '--on-accent': p.onAccent,
    '--accent-text': p.accentText,
    '--warning': p.warning,
    '--destructive': p.destructive,
    '--again': p.again,
    '--again-soft': p.againSoft,
  }
  for (const k of KINDS) {
    const s = kindStyle(k, p.scheme)
    const name = k.replace('_', '-')
    out[`--kind-${name}-bg`] = s.background
    out[`--kind-${name}-fg`] = s.text
  }
  return out
}

/** Sizes and spacing in px, the same numbers the phone uses (before its Dynamic Type scaling). */
function scaleEntries(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(space)) out[`--space-${k}`] = `${v}px`
  for (const [k, v] of Object.entries(type)) out[`--type-${k}`] = `${v}px`
  for (const [k, v] of Object.entries(radius)) out[`--radius-${k}`] = `${v}px`
  return out
}

const declarations = (entries: Record<string, string>) =>
  Object.entries(entries)
    .map(([k, v]) => `${k}:${v};`)
    .join('')

export function themeCss(): string {
  return (
    `:root{${declarations(paletteEntries(dark))}${declarations(scaleEntries())}}` +
    `@media (prefers-color-scheme: light){:root{${declarations(paletteEntries(light))}}}`
  )
}

/**
 * Put the palette on the page (once, before the first render). A constructable stylesheet is set
 * through the CSSOM, which the page's Content-Security-Policy (`style-src 'self'`) allows. A
 * browser without it gets the same variables through `style.setProperty` on the root element (also
 * CSSOM, so also allowed; a <style> element would be blocked), following `prefers-color-scheme`
 * with a `matchMedia` listener.
 */
export function installTheme(doc: Document = document): void {
  const win = doc.defaultView
  if (win && 'adoptedStyleSheets' in doc && typeof win.CSSStyleSheet === 'function') {
    try {
      const sheet = new win.CSSStyleSheet()
      sheet.replaceSync(themeCss())
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet]
      return
    } catch {
      // Fall through to inline properties.
    }
  }
  const root = doc.documentElement.style
  for (const [k, v] of Object.entries(scaleEntries())) root.setProperty(k, v)
  const apply = (isLight: boolean) => {
    for (const [k, v] of Object.entries(paletteEntries(isLight ? light : dark))) {
      root.setProperty(k, v)
    }
  }
  const query = win?.matchMedia?.('(prefers-color-scheme: light)')
  apply(query?.matches ?? false)
  query?.addEventListener?.('change', (e) => apply(e.matches))
}
