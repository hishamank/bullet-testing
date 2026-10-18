/**
 * Night calm: the slice-1 visual system (design brief §4). Dark is the primary look; light is the
 * muted daytime palette. Pure data, so it can be checked for contrast in Vitest.
 */

import type { ThoughtKind } from '@bullet/core'

export interface Palette {
  scheme: 'dark' | 'light'
  background: string
  card: string
  raised: string
  raisedStrong: string
  hairline: string
  /** The bottom sheet / note surface (Failed artboard). */
  note: string
  text: string
  textSecondary: string
  textMuted: string
  /** Text on cards that should read a little softer than primary. */
  textSoft: string
  accent: string
  onAccent: string
  accentText: string
  warning: string
  destructive: string
}

export const dark: Palette = {
  scheme: 'dark',
  background: '#121417',
  card: '#1A1D21',
  raised: '#22262B',
  raisedStrong: '#2C3137',
  hairline: '#262A2F',
  note: '#1E2125',
  text: '#E8E5DF',
  textSecondary: '#A3A8AE',
  textMuted: '#7C828A',
  textSoft: '#C9CDD2',
  accent: '#3FBF9A',
  onAccent: '#06231B',
  accentText: '#6ED3B4',
  warning: '#E3B062',
  destructive: '#F08A80',
}

export const light: Palette = {
  scheme: 'light',
  background: '#F3F1EC',
  card: '#FBFAF7',
  raised: '#EAE7E0',
  raisedStrong: '#E0DCD3',
  hairline: '#DDD9D1',
  note: '#E9E6DF',
  text: '#23262A',
  textSecondary: '#5A6067',
  textMuted: '#646A71',
  textSoft: '#3A3F45',
  accent: '#0F6B54',
  onAccent: '#F3F1EC',
  accentText: '#0F6B54',
  warning: '#8A5E0F',
  destructive: '#A8402F',
}

export interface KindStyle {
  label: string
  background: string
  text: string
}

/** Thought-kind labels: always text, never colour alone. */
export const KIND_LABELS: Record<ThoughtKind, string> = {
  worry: 'worry',
  to_check: 'to check',
  question: 'question',
  idea: 'idea',
  note: 'note',
  task: 'task',
  event: 'event',
  tracker: 'tracker',
  activity: 'activity',
}

const KIND_COLOURS: Record<'dark' | 'light', Record<ThoughtKind, [string, string]>> = {
  dark: {
    worry: ['#2A2540', '#B7B0F0'],
    to_check: ['#183035', '#7FD3DE'],
    question: ['#1B2A3D', '#8DB9F0'],
    idea: ['#33301A', '#E6CF7A'],
    event: ['#3A2618', '#F0A877'],
    activity: ['#163029', '#6ED3B4'],
    tracker: ['#163029', '#6ED3B4'],
    task: ['#1C3022', '#8FD19E'],
    note: ['#262A2F', '#B6BBC1'],
  },
  light: {
    worry: ['#E7E3F8', '#4B3FA8'],
    to_check: ['#DCEFF1', '#145E68'],
    question: ['#E0E9F6', '#24518A'],
    idea: ['#F3ECCB', '#6B5710'],
    event: ['#F7E3D4', '#8A4515'],
    activity: ['#DBEFE8', '#0F6B54'],
    tracker: ['#DBEFE8', '#0F6B54'],
    task: ['#DFEEE2', '#276437'],
    note: ['#E6E4DF', '#4A5057'],
  },
}

export function kindStyle(kind: ThoughtKind, scheme: 'dark' | 'light'): KindStyle {
  const [background, text] = KIND_COLOURS[scheme][kind]
  return { label: KIND_LABELS[kind], background, text }
}

/** Point sizes before Dynamic Type scaling (RN scales Text with the user's setting). */
export const type = {
  capture: 28,
  title: 22,
  body: 17,
  bodySmall: 15,
  label: 13,
  caption: 12,
  tiny: 11,
} as const

export const radius = { card: 16, note: 14, pill: 999 } as const

export const size = {
  /** Minimum touch target (Apple HIG). */
  touch: 44,
  mic: 84,
  send: 48,
} as const

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 32 } as const

// ---- WCAG contrast (for tests and for anyone adding colours) ----

function channel(c: number): number {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16)
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  )
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
