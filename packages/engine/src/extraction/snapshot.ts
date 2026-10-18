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

/**
 * A tracker definition.
 *
 * The model only ever sees `name` + `input_type` (see prompt.ts `renderSnapshot`), but the row
 * carries the tracker's full `config` so the resolver can VALIDATE/CLAMP an appended
 * tracker_entry value against the definition's bounds (scale min/max, select option set,
 * number min/max). Only the resolver has the tracker in hand, so this check lives here.
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
 * The model only ever sees `title` + `status` (see prompt.ts `renderSnapshot`). A mark-done is a
 * field-level patch (`{ status: 'done' }`), so these fields are never echoed back into a payload
 * and a stale snapshot cannot revert the user's edits.
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
