'use client'

/**
 * A collapsible status group in the Tasks list — a rapid-logging heading (glyph · label · count)
 * that folds the tasks beneath it. Purely presentational; the page owns open-state + the mutations.
 */

import { TaskRow } from '@/components/tasks/task-row'
import type { EnrichedTask, TaskGroup as Group } from '@/lib/tasks-view-model'
import type { Bullet } from '@/lib/types'
import { cn } from '@/lib/utils'

export function TaskGroup({
  group,
  open,
  busy,
  expandedId,
  bulletsById,
  onToggle,
  onToggleExpand,
  onComplete,
  onMigrate,
  onReopen,
  onEdit,
}: {
  group: Group
  open: boolean
  busy: boolean
  expandedId: string | null
  bulletsById: Map<string, Bullet>
  onToggle: () => void
  onToggleExpand: (id: string) => void
  onComplete: (item: EnrichedTask) => void
  onMigrate: (item: EnrichedTask) => void
  onReopen: (item: EnrichedTask) => void
  onEdit: (item: EnrichedTask) => void
}) {
  return (
    <section className="mt-[26px]">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-[10px] border-line border-b pb-2 text-left"
      >
        <span className={cn('w-4 text-center font-data text-[15px]', group.meta.glyphClass)}>
          {group.meta.glyph}
        </span>
        <span className="font-data text-[11px] text-muted uppercase tracking-[0.14em]">
          {group.meta.label}
        </span>
        <span className="font-data text-[11px] text-faint-3">{group.count}</span>
        <span className="flex-1" />
        <span className="font-data text-[12px] text-faint-3">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div>
          {group.tasks.map((item) => (
            <TaskRow
              key={item.task.id}
              item={item}
              bullet={
                item.task.source_bullet_id ? bulletsById.get(item.task.source_bullet_id) : undefined
              }
              expanded={expandedId === item.task.id}
              busy={busy}
              onToggleExpand={() => onToggleExpand(item.task.id)}
              onComplete={() => onComplete(item)}
              onMigrate={() => onMigrate(item)}
              onReopen={() => onReopen(item)}
              onEdit={() => onEdit(item)}
            />
          ))}
        </div>
      )}
    </section>
  )
}
