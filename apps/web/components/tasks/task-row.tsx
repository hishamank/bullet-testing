'use client'

/**
 * One task in the status-grouped list. Reading, not Jira: the title in the writing serif, a quiet
 * row of margin tags (priority · due · migrated · manual), an expandable provenance thread back to
 * the source bullet (and/or its notes), and a small cluster of live actions on the right.
 *
 * The row is presentational — the page owns the mutations; every field here comes pre-derived from
 * the view-model's `EnrichedTask`.
 */

import Link from 'next/link'
import { formatTime, shortDay } from '@/lib/format'
import type { EnrichedTask } from '@/lib/tasks-view-model'
import type { Bullet } from '@/lib/types'
import { cn } from '@/lib/utils'

function ActionButton({
  label,
  onClick,
  disabled,
  className,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  className?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex h-7 w-7 flex-none items-center justify-center rounded-[8px] text-faint-3 transition-colors disabled:opacity-40',
        className,
      )}
    >
      {children}
    </button>
  )
}

export function TaskRow({
  item,
  bullet,
  expanded,
  busy,
  onToggleExpand,
  onComplete,
  onMigrate,
  onReopen,
  onEdit,
}: {
  item: EnrichedTask
  bullet?: Bullet
  expanded: boolean
  busy: boolean
  onToggleExpand: () => void
  onComplete: () => void
  onMigrate: () => void
  onReopen: () => void
  onEdit: () => void
}) {
  const { task } = item
  // The source bullet may be gone (the §4.6 "delete but keep extractions" flow leaves the task's
  // source_bullet_id pointing at a soft-deleted bullet, absent from the active list). So "can we
  // reveal a quote?" is the row's call — it has the bullet — not the task-only `showProvRow`.
  const showQuote = item.extracted && !!bullet
  const canReveal = showQuote || item.hasNotes
  const provLabel = showQuote
    ? `↳ from your journal · ${shortDay(bullet.created_at)} ${formatTime(bullet.created_at)}`
    : 'notes'

  return (
    <div className="flex gap-[13px] border-line-soft border-t px-[2px] py-[13px] transition-colors hover:bg-panel">
      {/* Glyph — toggles the provenance/notes thread when there's one to show. */}
      {canReveal ? (
        <button
          type="button"
          onClick={onToggleExpand}
          aria-expanded={expanded}
          aria-label={expanded ? 'Hide details' : 'Show details'}
          className={cn(
            'mt-[2px] w-4 flex-none text-center font-data text-[16px]',
            item.glyphClass,
          )}
        >
          {item.glyph}
        </button>
      ) : (
        <span
          className={cn(
            'mt-[2px] w-4 flex-none text-center font-data text-[16px]',
            item.glyphClass,
          )}
        >
          {item.glyph}
        </span>
      )}

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-[11px]">
          <span
            className={cn(
              'font-reader text-[18px] leading-snug',
              item.titleClass,
              item.strike && 'line-through decoration-faint-4',
            )}
          >
            {task.title}
          </span>
          {item.priority && (
            <span
              className={cn(
                'rounded-[5px] px-[7px] py-[2px] font-data text-[10.5px] tracking-[0.04em]',
                item.priority.textClass,
                item.priority.bgClass,
              )}
            >
              {item.priority.label}
            </span>
          )}
          {item.due && (
            <span className={cn('font-data text-[11.5px]', item.due.className)}>
              {item.due.label}
            </span>
          )}
          {item.isMigrated && (
            <span className="inline-flex items-center gap-[5px] whitespace-nowrap rounded-[5px] bg-indigo-wash px-2 py-[2px] font-data text-[11px] text-indigo">
              › carried forward
            </span>
          )}
        </div>

        {item.isManual && (
          <div className="mt-[5px] font-data text-[11px] text-faint-3">✎ added by hand</div>
        )}

        {canReveal && (
          <button
            type="button"
            onClick={onToggleExpand}
            aria-expanded={expanded}
            className="mt-[5px] inline-flex items-center gap-[5px] font-data text-[11px] text-faint-2 transition-colors hover:text-indigo"
          >
            {provLabel}
          </button>
        )}

        {expanded && canReveal && (
          <div className="mt-[9px] max-w-[560px] rounded-r-[10px] border border-line border-l-2 border-l-indigo-soft bg-panel px-[15px] py-3">
            {showQuote && (
              <>
                <div className="mb-[5px] font-data text-[10px] text-faint-3 tracking-[0.06em]">
                  {shortDay(bullet.created_at)} · {formatTime(bullet.created_at)}
                </div>
                <div className="font-reader text-[15px] text-muted italic leading-relaxed">
                  “{bullet.text}”
                </div>
                <Link
                  href="/timeline"
                  className="mt-[10px] inline-block font-data text-[11px] text-indigo hover:underline"
                >
                  Open in Timeline →
                </Link>
              </>
            )}
            {item.hasNotes && (
              <>
                <div
                  className={cn(
                    'mb-[5px] font-data text-[10px] text-faint-2 uppercase tracking-[0.12em]',
                    showQuote && 'mt-[11px]',
                  )}
                >
                  Notes
                </div>
                <div className="font-ui text-[13.5px] text-muted-soft leading-relaxed">
                  {task.notes}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div className="mt-[1px] flex flex-none items-start gap-[2px]">
        {item.showComplete && (
          <ActionButton
            label="Complete"
            onClick={onComplete}
            disabled={busy}
            className="text-[14px] hover:bg-sage-wash hover:text-sage"
          >
            ✓
          </ActionButton>
        )}
        {item.showMigrate && (
          <ActionButton
            label="Migrate — carry forward"
            onClick={onMigrate}
            disabled={busy}
            className="font-data text-[17px] hover:bg-indigo-wash hover:text-indigo"
          >
            ›
          </ActionButton>
        )}
        {item.showReopen && (
          <ActionButton
            label="Reopen"
            onClick={onReopen}
            disabled={busy}
            className="text-[14px] hover:bg-line hover:text-muted-soft"
          >
            ↺
          </ActionButton>
        )}
        <ActionButton
          label="Edit"
          onClick={onEdit}
          disabled={busy}
          className="text-[13px] hover:bg-line hover:text-indigo"
        >
          ✎
        </ActionButton>
      </div>
    </div>
  )
}
