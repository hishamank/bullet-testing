/**
 * The ExtractionSnapshot — the inlined current state we hand the model so it can decide
 * create-vs-append (CLAUDE.md §4.4) by referencing EXISTING definitions/instances by name.
 *
 * It contains exactly what the resolver needs to match against:
 *   - active tracker DEFINITIONS (for "log under a definition", e.g. run → tracker entry), and
 *   - OPEN tasks (todo/in_progress) (for "mutate an existing instance", e.g. "called the
 *     dentist" → mark that task done).
 *
 * It is deliberately small (id + the human-facing field + the kind of input) so the prompt
 * stays compact and the model references things by NAME, not by leaking ids.
 */

import type { TaskPriority, TrackerConfig, TrackerInputType } from '@bullet/core'
import { listTasks, listTrackers } from '@bullet/db'
import type { AgentDeps } from '../deps'

/**
 * A tracker definition.
 *
 * The model only ever sees `name` + `input_type` (see prompt.ts `renderSnapshot`), but the row
 * carries the tracker's full `config` so the resolver can VALIDATE/CLAMP an appended
 * tracker_entry value against the definition's bounds (scale min/max, select option set,
 * number min/max). @bullet/db's apply engine explicitly DEFERS this check to the agent (see the
 * TODO in packages/db apply.ts `applyAppend`), since only the resolver has the tracker in hand.
 */
export interface SnapshotTracker {
  id: string
  name: string
  input_type: TrackerInputType
  config: TrackerConfig
}

/**
 * An open task.
 *
 * The model only ever sees `title` + `status` (see prompt.ts `renderSnapshot`), but the row
 * carries the remaining MUTABLE task fields (`notes`/`due_at`/`priority`) so the resolver can
 * build a mark-done UPDATE payload that satisfies @bullet/db's full INSERT-schema re-validation
 * (apply.ts validates EVERY payload against `taskInsertSchema`, which requires those keys present).
 * Carrying the live values unchanged is safe: `applyUpdate` only patches keys the RAW payload
 * proposes, so re-supplying them is a no-op on those fields.
 */
export interface SnapshotTask {
  id: string
  title: string
  status: 'todo' | 'in_progress'
  notes: string | null
  due_at: number | null
  priority: TaskPriority | null
}

/** The inlined current state given to the extraction model + the resolver. */
export interface ExtractionSnapshot {
  trackers: SnapshotTracker[]
  openTasks: SnapshotTask[]
}

/** Task statuses considered "open" (still actionable, so a candidate for a mark-done update). */
const OPEN_TASK_STATUSES = ['todo', 'in_progress'] as const

/**
 * Build the snapshot for an owner by querying @bullet/db: active tracker definitions and open
 * tasks. (Both `listTrackers`/`listTasks` already exclude soft-deleted rows by default.)
 */
export function buildSnapshot(deps: Pick<AgentDeps, 'db'>, ownerId: string): ExtractionSnapshot {
  const trackers: SnapshotTracker[] = listTrackers(deps.db, ownerId).map((t) => ({
    id: t.id,
    name: t.name,
    input_type: t.input_type,
    config: t.config,
  }))

  const openTasks: SnapshotTask[] = listTasks(deps.db, ownerId)
    .filter((t): t is typeof t & { status: 'todo' | 'in_progress' } =>
      (OPEN_TASK_STATUSES as readonly string[]).includes(t.status),
    )
    .map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      notes: t.notes,
      due_at: t.due_at,
      priority: t.priority,
    }))

  return { trackers, openTasks }
}
