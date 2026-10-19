/**
 * The limits on reflective questions (`REFLECTIVE_CAPS` in core), as one pure decision over a
 * summary of the user's state. The server builds the summary from its database (all three
 * origins together) and asks before every new question, and again inside the transaction that
 * stores it; the phone asks before a user's evergreen pick.
 */

import { type QuestionOrigin, REFLECTIVE_CAPS } from '@bullet/core'

export interface ReflectiveState {
  /** Reflective questions open or snoozed now. */
  open: number
  /** Reflective questions created in the last 24 hours. */
  createdLastDay: number
  /** The newest active capture's time; null when there is none. */
  lastCaptureAt: number | null
  /** When the newest evergreen question was created; null when never. */
  lastEvergreenAt: number | null
  /** The newest sensitive thought's time; null when none. */
  lastSensitiveAt: number | null
}

/** Why no new question now (null when one may be asked). */
export type ReflectiveRefusal =
  | 'open_cap'
  | 'daily_cap'
  | 'quiet'
  | 'evergreen_not_alone'
  | 'evergreen_too_soon'
  | 'sensitive_pause'

/**
 * May the app ask a new reflective question of this origin at `now`?
 *  - every origin: fewer than 3 open, fewer than 2 new in 24 h, a capture in the last 14 days;
 *  - evergreen also: nothing else open, none in the last 3 days, no sensitive thought in 7 days.
 */
export function reflectiveRefusal(
  origin: QuestionOrigin,
  s: ReflectiveState,
  now: number,
): ReflectiveRefusal | null {
  const c = REFLECTIVE_CAPS
  if (s.open >= c.maxOpen) return 'open_cap'
  if (s.createdLastDay >= c.maxNewPerDay) return 'daily_cap'
  if (s.lastCaptureAt === null || now - s.lastCaptureAt >= c.quietAfterMs) return 'quiet'
  if (origin !== 'evergreen') return null
  if (s.open > 0) return 'evergreen_not_alone'
  if (s.lastEvergreenAt !== null && now - s.lastEvergreenAt < c.evergreenEveryMs) {
    return 'evergreen_too_soon'
  }
  if (s.lastSensitiveAt !== null && now - s.lastSensitiveAt < c.sensitivePauseMs) {
    return 'sensitive_pause'
  }
  return null
}

/** A question the user picks from the evergreen list may go one over the open cap. */
export function mayPickEvergreen(open: number): boolean {
  return open < REFLECTIVE_CAPS.maxOpen + 1
}
