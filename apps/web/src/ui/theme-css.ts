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

function paletteVars(p: Palette): string {
  const kinds = KINDS.map((k) => {
    const s = kindStyle(k, p.scheme)
    return `--kind-${k.replace('_', '-')}-bg:${s.background};--kind-${k.replace('_', '-')}-fg:${s.text};`
  }).join('')
  return (
    `color-scheme:${p.scheme};` +
    `--bg:${p.background};--card:${p.card};--raised:${p.raised};--raised-strong:${p.raisedStrong};` +
    `--hairline:${p.hairline};--note:${p.note};--text:${p.text};--text-2:${p.textSecondary};` +
    `--muted:${p.textMuted};--soft:${p.textSoft};--accent:${p.accent};--on-accent:${p.onAccent};` +
    `--accent-text:${p.accentText};--warning:${p.warning};--destructive:${p.destructive};` +
    `--again:${p.again};--again-soft:${p.againSoft};` +
    kinds
  )
}

/** Sizes and spacing in px, the same numbers the phone uses (before its Dynamic Type scaling). */
const scaleVars =
  Object.entries(space)
    .map(([k, v]) => `--space-${k}:${v}px;`)
    .join('') +
  Object.entries(type)
    .map(([k, v]) => `--type-${k}:${v}px;`)
    .join('') +
  Object.entries(radius)
    .map(([k, v]) => `--radius-${k}:${v}px;`)
    .join('')

export function themeCss(): string {
  return (
    `:root{${paletteVars(dark)}${scaleVars}}` +
    `@media (prefers-color-scheme: light){:root{${paletteVars(light)}}}`
  )
}

/** Put the palette on the page (once, before the first render). */
export function installTheme(doc: Document = document): void {
  const style = doc.createElement('style')
  style.id = 'theme-tokens'
  style.textContent = themeCss()
  doc.head.prepend(style)
}
