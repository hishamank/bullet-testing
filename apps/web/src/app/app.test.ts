import { dark, light } from '@bullet/client/theme'
import { describe, expect, test, vi } from 'vite-plus/test'
import { sparkGeometry } from '../ui/Sparkline'
import { installTheme, themeCss } from '../ui/theme-css'
import { fromLocalInput, toLocalInput } from './datetime'
import {
  isSendShortcut,
  layoutFor,
  NARROW_MAX_WIDTH,
  nextIndex,
  planFor,
  WIDE_MIN_WIDTH,
} from './layout'
import { defaultRoute, formatHash, parseHash, toView, withPanel } from './router'
import { onDeviceText, syncIndicator } from './status'

describe('router', () => {
  test('main views round-trip', () => {
    for (const hash of ['#/capture', '#/inbox', '#/journal/stream', '#/journal/plans']) {
      expect(formatHash(parseHash(hash))).toBe(hash)
    }
  })

  test('unknown or empty locations land on Capture; a bad journal tab on the Stream', () => {
    expect(parseHash('')).toEqual(defaultRoute)
    expect(parseHash('#/nowhere')).toEqual(defaultRoute)
    expect(parseHash('#/journal/nonsense').tab).toBe('stream')
    expect(parseHash('#/journal').view).toBe('journal')
  })

  test('the open panel is part of the address and round-trips', () => {
    const panels = [
      { kind: 'capture', id: 'abc' },
      { kind: 'capture', id: 'abc', write: true },
      { kind: 'edit', id: 's1' },
      { kind: 'answer', target: 'question', id: 'q1' },
      { kind: 'answer', target: 'thought', id: 't1' },
      { kind: 'theme', id: 'th' },
      { kind: 'merge', id: 'th' },
      { kind: 'plan', id: 'p' },
      { kind: 'tracker', id: 'tr' },
      { kind: 'activity', name: 'Went for a run: 5 km / easy' },
      { kind: 'pick' },
      { kind: 'settings' },
    ] as const
    for (const panel of panels) {
      const route = withPanel(toView('inbox'), panel)
      expect(parseHash(formatHash(route)), formatHash(route)).toEqual(route)
    }
  })

  test('a broken panel is ignored, the view stays', () => {
    expect(parseHash('#/inbox?panel=capture:').panel).toBeNull()
    expect(parseHash('#/inbox?panel=answer:thing:1').panel).toBeNull()
    expect(parseHash('#/inbox?panel=wat:1').panel).toBeNull()
    expect(parseHash('#/inbox?panel=capture:%E0%A4%A').panel).not.toBeNull()
  })

  test('going to a view closes the panel', () => {
    expect(toView('journal', 'loops')).toEqual({ view: 'journal', tab: 'loops', panel: null })
  })
})

describe('layout', () => {
  test('phone width: tab bar and full-page panels, no side column', () => {
    expect(layoutFor(375)).toBe('narrow')
    expect(layoutFor(NARROW_MAX_WIDTH)).toBe('narrow')
    expect(planFor(375)).toEqual({ rail: 'bottom', panel: 'page', captureBox: 'bottom' })
  })

  test('between phone and desk the panel opens over the content', () => {
    expect(layoutFor(NARROW_MAX_WIDTH + 1)).toBe('medium')
    expect(planFor(900)).toEqual({ rail: 'left', panel: 'overlay', captureBox: 'bottom' })
  })

  test('a wide window has the panel beside the content', () => {
    expect(layoutFor(WIDE_MIN_WIDTH)).toBe('wide')
    expect(planFor(1440)).toEqual({ rail: 'left', panel: 'side', captureBox: 'bottom' })
  })

  test('arrow keys walk a list without wrapping', () => {
    expect(nextIndex(0, 3, 'ArrowDown')).toBe(1)
    expect(nextIndex(2, 3, 'ArrowDown')).toBe(2)
    expect(nextIndex(0, 3, 'ArrowUp')).toBe(0)
    expect(nextIndex(2, 3, 'ArrowUp')).toBe(1)
    expect(nextIndex(1, 3, 'Home')).toBe(0)
    expect(nextIndex(1, 3, 'End')).toBe(2)
    expect(nextIndex(1, 3, 'a')).toBeNull()
    expect(nextIndex(0, 0, 'ArrowDown')).toBeNull()
    // Focus is not on a stop yet (index -1): Down goes to the first one.
    expect(nextIndex(-1, 3, 'ArrowDown')).toBe(0)
  })

  test('Cmd or Ctrl + Enter sends; plain Enter and Shift+Enter write a new line', () => {
    const key = { key: 'Enter', metaKey: false, ctrlKey: false }
    expect(isSendShortcut({ ...key, metaKey: true })).toBe(true)
    expect(isSendShortcut({ ...key, ctrlKey: true })).toBe(true)
    expect(isSendShortcut(key)).toBe(false)
    expect(isSendShortcut({ ...key, shiftKey: true })).toBe(false)
    expect(isSendShortcut({ key: 'a', metaKey: true, ctrlKey: false })).toBe(false)
  })
})

describe('sync indicator', () => {
  const base = {
    paired: true,
    syncing: false,
    reachability: 'ok',
    cannotReach: false,
    onDevice: 0,
  } as const

  test('synced, syncing, can’t reach, N on this device', () => {
    expect(syncIndicator(base)).toMatchObject({ kind: 'synced', label: 'Synced' })
    expect(syncIndicator({ ...base, syncing: true })).toMatchObject({
      kind: 'syncing',
      label: 'Syncing…',
    })
    expect(syncIndicator({ ...base, cannotReach: true })).toMatchObject({
      kind: 'unreachable',
      label: "Can't reach",
    })
    expect(syncIndicator({ ...base, onDevice: 3 })).toMatchObject({
      kind: 'on-device',
      label: '3 on this device · will sync',
    })
  })

  test('can’t reach wins over everything, and says what is waiting', () => {
    const out = syncIndicator({ ...base, syncing: true, cannotReach: true, onDevice: 2 })
    expect(out.kind).toBe('unreachable')
    expect(out.detail).toContain(onDeviceText(2))
  })

  test('a refused token and an unpaired browser are their own states', () => {
    expect(syncIndicator({ ...base, reachability: 'unauthorized', cannotReach: true }).kind).toBe(
      'unauthorized',
    )
    expect(syncIndicator({ ...base, paired: false }).kind).toBe('unpaired')
  })
})

describe('date and time fields', () => {
  test('a local time round-trips through the field', () => {
    const ms = new Date(2026, 9, 15, 15, 30).getTime()
    expect(toLocalInput(ms)).toBe('2026-10-15T15:30')
    expect(fromLocalInput(toLocalInput(ms))).toBe(ms)
  })

  test('empty and impossible values are nothing', () => {
    expect(fromLocalInput('')).toBeNull()
    expect(fromLocalInput('2026-10-15')).toBeNull()
    expect(fromLocalInput('2026-02-31T10:00')).toBeNull()
  })
})

describe('theme', () => {
  test('both palettes come from the shared tokens, dark first, light by preference', () => {
    const css = themeCss()
    expect(css).toContain(`--bg:${dark.background}`)
    expect(css).toContain(`--bg:${light.background}`)
    expect(css.indexOf(dark.background)).toBeLessThan(css.indexOf('prefers-color-scheme: light'))
    expect(css).toContain('--kind-to-check-bg')
    expect(css).toContain('--space-lg:16px')
  })

  test('without constructable stylesheets the palette goes in as CSSOM properties, not a <style> element', () => {
    const doc = document.implementation.createHTMLDocument('t')
    expect('adoptedStyleSheets' in doc).toBe(false)
    let listener: ((e: { matches: boolean }) => void) | undefined
    const query = {
      matches: false,
      addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => {
        listener = fn
      },
    }
    const view = { matchMedia: vi.fn(() => query) }
    Object.defineProperty(doc, 'defaultView', { value: view })
    installTheme(doc)
    const bg = () => doc.documentElement.style.getPropertyValue('--bg')
    expect(doc.querySelector('style')).toBeNull()
    expect(bg()).toBe(dark.background)
    expect(doc.documentElement.style.getPropertyValue('--space-lg')).toBe('16px')
    expect(view.matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: light)')
    listener?.({ matches: true })
    expect(bg()).toBe(light.background)
    listener?.({ matches: false })
    expect(bg()).toBe(dark.background)
  })

  test('no web fonts and no remote anything', () => {
    expect(themeCss()).not.toMatch(/url\(|@import|http/)
  })
})

describe('sparkline geometry', () => {
  test('nothing to draw', () => {
    expect(sparkGeometry({ mode: 'none' })).toEqual({ mode: 'none' })
  })

  test('bars skip empty days and scale to the busiest one', () => {
    const shape = sparkGeometry({ mode: 'bars', counts: [0, 1, 0, 2] })
    if (shape.mode !== 'bars') throw new Error('expected bars')
    expect(shape.bars).toHaveLength(2)
    expect(shape.bars[1]?.h).toBeGreaterThan(shape.bars[0]?.h ?? 0)
  })

  test('a gap in the readings breaks the line', () => {
    const shape = sparkGeometry({ mode: 'line', values: [1, 2, null, 3, 4] })
    if (shape.mode !== 'line') throw new Error('expected a line')
    expect(shape.points).toHaveLength(4)
    expect(shape.segments).toHaveLength(2)
  })
})
