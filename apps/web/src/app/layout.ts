/**
 * Layout helpers, pure. The CSS owns the layout (`styles.css` uses the same breakpoints); these
 * are the numbers and rules the code needs too: where the rail and the panel go at a given width,
 * and how arrow keys move through a list.
 */

/** At or below this width (CSS px) the rail is a bottom tab bar and panels are full pages. */
export const NARROW_MAX_WIDTH = 720

/** Below this width the content column and the panel no longer fit side by side. */
export const WIDE_MIN_WIDTH = 1100

export const NARROW_QUERY = `(max-width: ${NARROW_MAX_WIDTH}px)`
export const WIDE_QUERY = `(min-width: ${WIDE_MIN_WIDTH}px)`

export type Layout = 'narrow' | 'medium' | 'wide'

export function layoutFor(width: number): Layout {
  if (width <= NARROW_MAX_WIDTH) return 'narrow'
  return width < WIDE_MIN_WIDTH ? 'medium' : 'wide'
}

export interface LayoutPlan {
  /** Where the navigation sits. */
  rail: 'left' | 'bottom'
  /** `side`: next to the content. `overlay`: over the content, which stays behind it. `page`: replaces it. */
  panel: 'side' | 'overlay' | 'page'
  /** The capture box under the content column (a narrow window keeps it too, above the tab bar). */
  captureBox: 'bottom'
}

export function planFor(width: number): LayoutPlan {
  const layout = layoutFor(width)
  return {
    rail: layout === 'narrow' ? 'bottom' : 'left',
    panel: layout === 'narrow' ? 'page' : layout === 'medium' ? 'overlay' : 'side',
    captureBox: 'bottom',
  }
}

/**
 * Arrow-key navigation through a list of `count` items: Down/Up move by one without wrapping,
 * Home/End jump. Returns the new index, or null when the key isn't one of these.
 */
export function nextIndex(current: number, count: number, key: string): number | null {
  if (count <= 0) return null
  switch (key) {
    case 'ArrowDown':
      return Math.min(count - 1, current + 1)
    case 'ArrowUp':
      return Math.max(0, current <= 0 ? 0 : current - 1)
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

/** Cmd+Enter (Mac) or Ctrl+Enter sends; plain Enter is a new line. */
export function isSendShortcut(e: {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey?: boolean
  altKey?: boolean
}): boolean {
  return e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.altKey
}
