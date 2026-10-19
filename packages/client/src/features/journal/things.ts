/**
 * The things a capture produced, as Capture detail shows them: one line per suggestion with its
 * review state and where tapping it goes. Labels read the applied thing when there is one (the
 * user may have edited it since), else the suggestion's payload. Pure.
 */

import type { TargetKind, TrackerConfig, TrackerEntryValue } from '@bullet/core'
import { fullWhen } from './format'

export type ThingState = 'review' | 'done_for_you' | 'added' | 'dismissed' | 'removed'

export interface SuggestionRow {
  id: string
  source_thought_id: string | null
  target_kind: TargetKind
  operation: 'create' | 'append' | 'update'
  target_id: string | null
  payload: Record<string, unknown>
  status: 'pending' | 'accepted' | 'edited' | 'rejected'
  auto_applied: boolean
  applied_entity_id: string | null
}

export interface ThingLookup {
  /** The applied (or targeted) row, current values; `state` tells a deleted one. */
  entity: (kind: TargetKind, id: string) => Record<string, unknown> | null
  tracker: (id: string) => { name: string; config: TrackerConfig } | null
}

export type ThingLink =
  | { to: 'inbox' }
  | { to: 'plans'; item: string }
  | { to: 'trackers'; tracker: string }
  | { to: 'activities'; name: string }
  | null

export interface LinkedThing {
  suggestionId: string
  thoughtId: string | null
  kind: TargetKind
  label: string
  state: ThingState
  link: ThingLink
  /** Applied for the user automatically: offer Undo (the Inbox's Done-for-you path). */
  undoable: boolean
}

const KIND_WORDS: Record<TargetKind, string> = {
  task: 'Task',
  event: 'Event',
  tracker: 'New tracker',
  tracker_entry: 'Reading',
  activity: 'Activity',
  thought_resolve: 'Closed a loop',
}

export const THING_STATE_LABELS: Record<ThingState, string> = {
  review: 'Review',
  done_for_you: 'done for you',
  added: 'added',
  dismissed: 'dismissed',
  removed: 'deleted',
}

/** A reading in words: "3 / 5", "72 kg", "yes", "tea, coffee". */
export function entryValueText(value: TrackerEntryValue, config?: TrackerConfig | null): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'number') {
    if (config?.input_type === 'scale') return `${value} / ${config.max}`
    if (config?.input_type === 'number' && config.unit) return `${value} ${config.unit}`
    return String(value)
  }
  return value
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function thingState(s: SuggestionRow, entity: Record<string, unknown> | null): ThingState {
  if (s.status === 'pending') return 'review'
  if (s.status === 'rejected') return 'dismissed'
  if (entity && entity.state === 'deleted') return 'removed'
  return s.auto_applied ? 'done_for_you' : 'added'
}

export function linkedThing(
  s: SuggestionRow,
  look: ThingLookup,
  now: number,
  tz: string,
): LinkedThing {
  const entityId = s.applied_entity_id ?? s.target_id
  const entity = entityId ? look.entity(s.target_kind, entityId) : null
  // The thing as it is now: the row's current values over what was proposed.
  const f: Record<string, unknown> = { ...s.payload, ...entity }
  const state = thingState(s, entity)
  const parts: string[] = [KIND_WORDS[s.target_kind]]
  let link: ThingLink = null

  switch (s.target_kind) {
    case 'task': {
      const title = str(f.title)
      if (title) parts.push(title)
      if (s.operation === 'update' && s.payload.status === 'done') parts.push('mark done')
      const due = num(f.due_at)
      if (due !== null) parts.push(`due ${fullWhen(due, now, tz)}`)
      if (entityId) link = { to: 'plans', item: entityId }
      break
    }
    case 'event': {
      const title = str(f.title)
      if (title) parts.push(title)
      const start = num(f.starts_at)
      if (start !== null) parts.push(fullWhen(start, now, tz))
      if (entityId) link = { to: 'plans', item: entityId }
      break
    }
    case 'tracker': {
      const name = str(f.name)
      if (name) parts.push(name)
      if (entityId) link = { to: 'trackers', tracker: entityId }
      break
    }
    case 'tracker_entry': {
      const trackerId = str(f.tracker_id)
      const tracker = trackerId ? look.tracker(trackerId) : null
      if (tracker) parts[0] = tracker.name
      const value = f.value as TrackerEntryValue | undefined
      if (value !== undefined && value !== null) parts.push(entryValueText(value, tracker?.config))
      if (trackerId) link = { to: 'trackers', tracker: trackerId }
      break
    }
    case 'activity': {
      const name = str(f.name)
      if (name) parts.push(name)
      const qty = num(f.quantity)
      if (qty !== null) parts.push([qty, str(f.unit)].filter((x) => x !== null).join(' '))
      const trackerId = str(f.tracker_id)
      if (trackerId) link = { to: 'trackers', tracker: trackerId }
      else if (name) link = { to: 'activities', name }
      break
    }
  }
  if (state === 'review') link = { to: 'inbox' }
  if (state === 'dismissed' || state === 'removed') link = null
  return {
    suggestionId: s.id,
    thoughtId: s.source_thought_id,
    kind: s.target_kind,
    label: parts.join(' · '),
    state,
    link,
    undoable: state === 'done_for_you',
  }
}
