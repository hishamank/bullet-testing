/**
 * Tapped answers to clarifying questions, as pure functions shared by the server (which applies
 * them) and the phone (which shows them at once, offline).
 */

import { type CaptureContext, resolveDateAnswer } from '../time/when'

/** The kinds a `date` question can be about, and the field holding their date. */
export const DATE_ANSWER_FIELD = { task: 'due_at', event: 'starts_at' } as const
export type DateAnswerKind = keyof typeof DATE_ANSWER_FIELD

/**
 * The date fields a tapped `date` option writes on a task (`due_at`) or event (`starts_at`, with
 * `ends_at` moved by the same amount), from its current values `from` (a suggestion payload or the
 * applied row). Keeps the time of day when the option names only a day. Null when the option names
 * no date.
 */
export function dateAnswerFields(
  kind: DateAnswerKind,
  from: Record<string, unknown>,
  option: string,
  ctx: CaptureContext,
): Record<string, number | null> | null {
  const current = from[DATE_ANSWER_FIELD[kind]]
  const at = resolveDateAnswer(option, typeof current === 'number' ? current : null, ctx)
  if (at === null) return null
  if (kind === 'task') return { due_at: at }
  const start = typeof from.starts_at === 'number' ? from.starts_at : at
  const end = typeof from.ends_at === 'number' ? from.ends_at + (at - start) : null
  return { starts_at: at, ends_at: end }
}

/** A `new_tracker` answer: true for "Yes", false for "No", null for anything else. */
export function yesNoAnswer(option: string): boolean | null {
  const o = option.trim().toLowerCase()
  return o === 'yes' ? true : o === 'no' ? false : null
}
