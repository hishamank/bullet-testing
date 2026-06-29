/**
 * The Margin Notebook empty state — a calm row of glyphs, an Instrument Serif line, and a quiet
 * paragraph. Used for the first-run stream, the cleared review inbox, and the "coming next" tabs.
 */

import { cn } from '@/lib/utils'

export function EmptyState({
  glyphs,
  title,
  body,
  className,
}: {
  glyphs: string
  title: string
  body: string
  className?: string
}) {
  return (
    <div
      className={cn('flex h-full flex-col items-center justify-center px-8 text-center', className)}
    >
      <div className="mb-4 font-data text-[20px] text-indigo tracking-[0.32em]">{glyphs}</div>
      <div className="mb-2 font-display text-[30px] text-ink leading-tight">{title}</div>
      <p className="m-0 max-w-[400px] font-reader text-[16px] text-muted leading-relaxed">{body}</p>
    </div>
  )
}
