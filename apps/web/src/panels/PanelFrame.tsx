/**
 * The right-side panel's frame. Beside the content on a wide window, over it on a medium one and a
 * full page at phone width (the CSS decides, see `layout.ts`). Opening moves focus to the title;
 * Escape or Close puts it back where it was.
 */

import { type ReactNode, useEffect, useId, useRef } from 'react'
import { useNav } from '../app/nav'
import { Button } from '../ui/primitives'

export function PanelFrame({
  title,
  children,
  actions,
}: {
  title: string
  children: ReactNode
  /** Buttons beside Close (Edit, Save…). */
  actions?: ReactNode
}) {
  const nav = useNav()
  const titleId = useId()
  const heading = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    heading.current?.focus()
    return () => {
      if (before && document.contains(before)) before.focus()
    }
  }, [])

  return (
    <aside
      className="panel"
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) {
          e.stopPropagation()
          nav.closePanel()
        }
      }}
    >
      <header className="panel-head">
        <h2 id={titleId} ref={heading} tabIndex={-1} className="panel-title">
          {title}
        </h2>
        <div className="panel-actions">
          {actions}
          <Button variant="quiet" onClick={() => nav.closePanel()}>
            Close
          </Button>
        </div>
      </header>
      <div className="panel-body">{children}</div>
    </aside>
  )
}

/** The calm stand-in when what a panel pointed at is gone. */
export function PanelGone({ children }: { children: ReactNode }) {
  return <p className="empty-note">{children}</p>
}
