/** Small building blocks in the night-calm style. Markup only; no domain logic. */

import { textDirection } from '@bullet/client'
import type { ThoughtKind } from '@bullet/core'
import type { ButtonHTMLAttributes, KeyboardEvent, ReactNode } from 'react'
import { kindClass } from './kinds'
import { nextIndex } from '../app/layout'

type Variant = 'text' | 'primary' | 'option' | 'quiet' | 'danger'

export function Button({
  variant = 'text',
  className,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button type={type} className={`btn btn-${variant} ${className ?? ''}`.trim()} {...rest} />
}

/** The user's own words, laid out right to left when they read that way. */
export function Bidi({
  text,
  className,
  as: Tag = 'span',
}: {
  text: string
  className?: string
  as?: 'span' | 'p' | 'div'
}) {
  return (
    <Tag dir={textDirection(text)} className={className}>
      {text}
    </Tag>
  )
}

/** «the user's words», in the reading face; right to left when they read that way. */
export function Quoted({
  text,
  rtl,
  className,
}: {
  text: string
  rtl: boolean
  className?: string
}) {
  return (
    <span dir={rtl ? 'rtl' : 'ltr'} className={`quoted ${className ?? ''}`.trim()}>
      «{text}»
    </span>
  )
}

/** A thought kind: always its word, never colour alone. */
export function KindPill({ kind, label }: { kind: ThoughtKind; label: string }) {
  return <span className={`pill ${kindClass(kind)}`}>{label}</span>
}

export function SectionTitle({
  children,
  count,
  id,
  level = 2,
}: {
  children: ReactNode
  count?: number
  id?: string
  level?: 2 | 3
}) {
  const Tag = level === 2 ? 'h2' : 'h3'
  return (
    <Tag className="section-title" id={id}>
      {children}
      {count !== undefined ? <span className="count"> · {count}</span> : null}
    </Tag>
  )
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="empty-note">{children}</p>
}

/** A quiet note card (e.g. "Home server unreachable"), optionally dismissible. */
export function Note({
  text,
  onDismiss,
  action,
}: {
  text: string
  onDismiss?: () => void
  action?: ReactNode
}) {
  return (
    <div className="note" role="status">
      <div className="note-body">
        <p>{text}</p>
        {action}
      </div>
      {onDismiss ? (
        <Button variant="quiet" aria-label="Dismiss" onClick={onDismiss}>
          ✕
        </Button>
      ) : null}
    </div>
  )
}

export function Disclosure({
  title,
  open,
  onToggle,
}: {
  title: string
  open: boolean
  onToggle: () => void
}) {
  return (
    <button type="button" className="disclosure" aria-expanded={open} onClick={onToggle}>
      <span aria-hidden="true">{open ? '▾' : '▸'}</span> {title}
    </button>
  )
}

export function Checkbox({
  checked,
  label,
  onChange,
}: {
  checked: boolean
  label: string
  onChange: (next: boolean) => void
}) {
  return (
    <input
      type="checkbox"
      className="check"
      checked={checked}
      aria-label={label}
      onChange={(e) => onChange(e.target.checked)}
    />
  )
}

/** Lists a person can walk with the arrow keys: put `data-nav` on each stop. */
export function arrowNavHandler(e: KeyboardEvent<HTMLElement>) {
  const target = e.target as HTMLElement
  if (!target.hasAttribute('data-nav')) return
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-nav]'))
  const next = nextIndex(items.indexOf(target), items.length, e.key)
  if (next === null) return
  e.preventDefault()
  items[next]?.focus()
}

export function NavList({
  children,
  className,
  label,
}: {
  children: ReactNode
  className?: string
  label?: string
}) {
  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- arrow keys move focus between the real buttons inside
    <ul className={className} aria-label={label} onKeyDown={arrowNavHandler}>
      {children}
    </ul>
  )
}
