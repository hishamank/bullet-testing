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

import type { TrackerInputType } from '@bullet/core'
import { listTasks, listTrackers } from '@bullet/db'
import type { AgentDeps } from '../deps'

/** A tracker definition, as the model sees it. */
export interface SnapshotTracker {
  id: string
  name: string
  input_type: TrackerInputType
}

/** An open task, as the model sees it. */
export interface SnapshotTask {
  id: string
  title: string
  status: 'todo' | 'in_progress'
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
  }))

  const openTasks: SnapshotTask[] = listTasks(deps.db, ownerId)
    .filter((t): t is typeof t & { status: 'todo' | 'in_progress' } =>
      (OPEN_TASK_STATUSES as readonly string[]).includes(t.status),
    )
    .map((t) => ({ id: t.id, title: t.title, status: t.status }))

  return { trackers, openTasks }
}
