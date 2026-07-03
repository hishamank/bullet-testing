'use client'

/**
 * Tasks — everything you said you'd do, grouped by where it stands. A quiet, status-grouped list
 * (Migrated a first-class state, not a failure), with the same form Review uses to add one by hand.
 * Wired to the live `tasks.*` procedures; all shaping lives in `lib/tasks-view-model`.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useMemo, useState } from 'react'
import { EmptyState } from '@/components/empty-state'
import { TaskForm } from '@/components/tasks/task-form'
import { TaskGroup } from '@/components/tasks/task-group'
import {
  doneTaskCount,
  EMPTY_TASK_FORM,
  type EnrichedTask,
  groupTasks,
  openTaskCount,
  type TaskFormValues,
  taskFormValues,
} from '@/lib/tasks-view-model'
import { useTRPC } from '@/lib/trpc'
import type { TaskStatus } from '@/lib/types'
import { useJournalData } from '@/lib/use-journal-data'

/** Groups that start open — resolved work (Done) folds away until asked for. */
const DEFAULT_OPEN: TaskStatus[] = ['todo', 'in_progress', 'migrated', 'cancelled']

/** The first-run empty state (design B) — an invitation back to the stream, not an apology. */
function TasksEmpty({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-10 py-16 text-center">
      <div className="mb-5 font-data text-[20px] text-indigo tracking-[0.32em]">
        •&nbsp;&nbsp;/&nbsp;&nbsp;›
      </div>
      <h2 className="mb-[10px] font-display text-[31px] text-ink max-md:text-[26px]">
        Nothing to do yet — and that's fine.
      </h2>
      <p className="m-0 mb-6 max-w-[360px] font-reader text-[16.5px] text-muted leading-relaxed">
        Tasks don't start here — they surface from what you write. Empty your head in the stream,
        and anything that needs doing will show up, ready for you to confirm.
      </p>
      <Link
        href="/"
        className="inline-flex items-center gap-[9px] rounded-[24px] bg-indigo px-[22px] py-3 font-ui font-medium text-[14px] text-white transition-colors hover:bg-indigo-deep"
      >
        <span className="font-data text-[13px]">✎</span>Open the stream
      </Link>
      <button
        type="button"
        onClick={onNew}
        className="mt-[14px] font-ui text-[13px] text-faint transition-colors hover:text-indigo"
      >
        or add one by hand →
      </button>
    </div>
  )
}

export default function TasksPage() {
  const { tasks, bulletsById, isError, isLoading } = useJournalData()
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const create = useMutation(trpc.tasks.create.mutationOptions())
  const update = useMutation(trpc.tasks.update.mutationOptions())
  const del = useMutation(trpc.tasks.delete.mutationOptions())

  const [view, setView] = useState<'list' | 'form'>('list')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [openGroups, setOpenGroups] = useState<Set<TaskStatus>>(() => new Set(DEFAULT_OPEN))
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const groups = useMemo(() => groupTasks(tasks), [tasks])
  const openCount = openTaskCount(tasks)
  const doneCount = doneTaskCount(tasks)

  const editingTask = useMemo(
    () => (editingId ? tasks.find((t) => t.id === editingId) : undefined),
    [editingId, tasks],
  )

  async function run(fn: () => Promise<void>) {
    setBusy(true)
    setNotice(null)
    try {
      await fn()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Something went wrong — please try again.')
    } finally {
      setBusy(false)
      void queryClient.invalidateQueries()
    }
  }

  function toggleGroup(status: TaskStatus) {
    setOpenGroups((prev) => {
      const next = new Set(prev)
      if (next.has(status)) next.delete(status)
      else next.add(status)
      return next
    })
  }

  const openNew = () => {
    setEditingId(null)
    setNotice(null)
    setView('form')
  }
  const openEdit = (item: EnrichedTask) => {
    setEditingId(item.task.id)
    setNotice(null)
    setView('form')
  }
  const backToList = () => {
    setView('list')
    setEditingId(null)
  }

  const toNullable = (notes: string) => notes.trim() || null

  const submitForm = (values: TaskFormValues) =>
    run(async () => {
      const payload = {
        title: values.title.trim(),
        status: values.status,
        due_at: values.due_at,
        priority: values.priority,
        notes: toNullable(values.notes),
      }
      if (editingId) await update.mutateAsync({ id: editingId, ...payload })
      else await create.mutateAsync(payload)
      backToList()
    })

  const deleteEditing = () => {
    if (!editingId) return
    const id = editingId
    return run(async () => {
      await del.mutateAsync({ id })
      backToList()
    })
  }

  const setStatus = (item: EnrichedTask, status: TaskStatus) =>
    run(async () => {
      await update.mutateAsync({ id: item.task.id, status })
    })

  // --- render -------------------------------------------------------------------------------

  if (isError) {
    return (
      <EmptyState
        glyphs="•  /  ›"
        title="The journal server is asleep."
        body="Couldn't reach the local server on :3001. Start it, and everything you've set out to do will gather here."
      />
    )
  }

  if (view === 'form') {
    return (
      <TaskForm
        heading={editingTask ? 'Edit task' : 'New task'}
        submitLabel={editingTask ? 'Save changes' : 'Create task'}
        initial={editingTask ? taskFormValues(editingTask) : EMPTY_TASK_FORM}
        isEdit={!!editingTask}
        busy={busy}
        onSubmit={submitForm}
        onCancel={backToList}
        onDelete={editingTask ? deleteEditing : undefined}
      />
    )
  }

  const hasTasks = tasks.length > 0

  if (!hasTasks) {
    return (
      <div className="flex h-full flex-col">
        {isLoading ? (
          <div className="flex h-full items-center justify-center font-ui text-[14px] text-faint">
            Gathering your tasks…
          </div>
        ) : (
          <TasksEmpty onNew={openNew} />
        )}
      </div>
    )
  }

  return (
    <div className="px-10 pt-[34px] pb-16 max-md:px-5 max-md:pt-6">
      <div className="mx-auto max-w-[820px]">
        <div className="flex items-end justify-between gap-6">
          <div>
            <div className="font-data text-[11px] text-faint-2 uppercase tracking-[0.14em]">
              {openCount} open · {doneCount} done
            </div>
            <h2 className="mt-[6px] font-display text-[34px] text-ink max-md:text-[28px]">Tasks</h2>
          </div>
          <button
            type="button"
            onClick={openNew}
            className="inline-flex items-center gap-2 rounded-[22px] bg-indigo px-[17px] py-[10px] font-ui font-medium text-[13.5px] text-white transition-colors hover:bg-indigo-deep"
          >
            <span className="font-data text-[14px]">+</span>New task
          </button>
        </div>

        {notice && (
          <p className="mt-3 font-ui text-[12.5px] text-rust" role="alert">
            {notice}
          </p>
        )}

        {groups.map((group) => (
          <TaskGroup
            key={group.status}
            group={group}
            open={openGroups.has(group.status)}
            busy={busy}
            expandedId={expandedId}
            bulletsById={bulletsById}
            onToggle={() => toggleGroup(group.status)}
            onToggleExpand={(id) => setExpandedId((cur) => (cur === id ? null : id))}
            onComplete={(item) => setStatus(item, 'done')}
            onMigrate={(item) => setStatus(item, 'migrated')}
            onReopen={(item) => setStatus(item, 'todo')}
            onEdit={openEdit}
          />
        ))}
      </div>
    </div>
  )
}
