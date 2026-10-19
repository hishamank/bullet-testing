/**
 * Edit-then-accept: which fields of a suggestion the user may change, and turning their edits
 * back into a payload the server will take. Pure.
 */

import {
  entryValueFits,
  type SuggestionPayload,
  type TargetKind,
  type TrackerConfig,
  type TrackerEntryValue,
  validateSuggestionPayload,
} from '@bullet/core'
import type { SuggestionLike } from './summary'

export type EditForm =
  | { kind: 'task'; title: string; due_at: number | null }
  | { kind: 'event'; title: string; starts_at: number }
  | { kind: 'tracker'; name: string }
  | { kind: 'tracker_entry'; value: TrackerEntryValue }
  | { kind: 'activity'; name: string; quantity: string }

const text = (v: unknown) => (typeof v === 'string' ? v : '')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** The editable fields of a create/append suggestion, or null when it can't be edited here. */
export function editFormFor(s: SuggestionLike): EditForm | null {
  if (s.operation === 'update') return null
  const p = s.payload
  const kind: TargetKind = s.target_kind
  switch (kind) {
    case 'task':
      return { kind, title: text(p.title), due_at: num(p.due_at) }
    case 'event': {
      const starts = num(p.starts_at)
      return starts === null ? null : { kind, title: text(p.title), starts_at: starts }
    }
    case 'tracker':
      return { kind, name: text(p.name) }
    case 'tracker_entry':
      return p.value === undefined ? null : { kind, value: p.value as TrackerEntryValue }
    case 'activity': {
      const q = num(p.quantity)
      return { kind, name: text(p.name), quantity: q === null ? '' : String(q) }
    }
    case 'thought_resolve':
      return null
  }
}

/**
 * Moving an event's start keeps its length: the end shifts by the same amount. No end (or no
 * known start) leaves the end as it is.
 */
export function shiftEnd(
  start: number | null,
  end: number | null,
  newStart: number,
): number | null {
  return end !== null && start !== null ? end + (newStart - start) : end
}

export type EditResult = { ok: true; payload: SuggestionPayload } | { ok: false; message: string }

/** Parse a typed number ("5", "5,5", " 72.4 "); null when it isn't one. */
export function parseNumber(input: string): number | null {
  const t = input.trim().replace(',', '.')
  if (t === '' || !/^-?\d*\.?\d+$/.test(t)) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/**
 * The payload to accept with: the original with the edited fields replaced. An event keeps its
 * length when its start moves. Refuses (with a sentence for the user) what the server would.
 */
export function applyEdit(
  s: SuggestionLike,
  form: EditForm,
  trackerConfig?: TrackerConfig | null,
): EditResult {
  const p = s.payload
  let payload: SuggestionPayload
  switch (form.kind) {
    case 'task': {
      if (form.title.trim() === '') return { ok: false, message: 'Give it a title.' }
      payload = { ...p, title: form.title.trim(), due_at: form.due_at }
      break
    }
    case 'event': {
      if (form.title.trim() === '') return { ok: false, message: 'Give it a title.' }
      const ends_at = shiftEnd(num(p.starts_at), num(p.ends_at), form.starts_at)
      payload = { ...p, title: form.title.trim(), starts_at: form.starts_at, ends_at }
      break
    }
    case 'tracker': {
      if (form.name.trim() === '') return { ok: false, message: 'Give it a name.' }
      payload = { ...p, name: form.name.trim() }
      break
    }
    case 'tracker_entry': {
      if (trackerConfig && !entryValueFits(form.value, trackerConfig)) {
        return { ok: false, message: rangeHint(trackerConfig) }
      }
      payload = { ...p, value: form.value }
      break
    }
    case 'activity': {
      if (form.name.trim() === '') return { ok: false, message: 'Give it a name.' }
      const quantity = form.quantity.trim() === '' ? null : parseNumber(form.quantity)
      if (form.quantity.trim() !== '' && quantity === null) {
        return { ok: false, message: 'The amount should be a number.' }
      }
      payload = { ...p, name: form.name.trim(), quantity }
      break
    }
  }
  // Only hold the edit to the schema when the original passed it (the server is the judge).
  const before = validateSuggestionPayload(s.target_kind, p, s.operation)
  if (before.success && !validateSuggestionPayload(s.target_kind, payload, s.operation).success) {
    return { ok: false, message: "That change doesn't fit; try another value." }
  }
  return { ok: true, payload }
}

function rangeHint(config: TrackerConfig): string {
  switch (config.input_type) {
    case 'scale':
      return `Pick a value from ${config.min} to ${config.max}.`
    case 'number':
      return config.min !== undefined && config.max !== undefined
        ? `Pick a number from ${config.min} to ${config.max}.`
        : 'That number is out of range.'
    case 'single_select':
    case 'multi_select':
      return 'Pick from the options.'
    default:
      return "That value doesn't fit this tracker."
  }
}

/** Whether an edit changed anything (an unchanged "edit" is a plain accept). */
export function payloadChanged(a: SuggestionPayload, b: SuggestionPayload): boolean {
  return JSON.stringify(a) !== JSON.stringify(b)
}
