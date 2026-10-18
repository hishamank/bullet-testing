/**
 * Coalesce the database's per-row change events into screen refreshes. A pull page can write
 * hundreds of rows; screens should re-query once after the burst, not once per row. Writes the app
 * already refreshed for (`notifyLocalChange()` right after a local write) are skipped: their row
 * events arrive just after that refresh. Pure: the clock and timers are injected.
 */

export interface CoalescerOptions {
  /** Wait this long after the first row event of a burst, then refresh once. */
  delayMs: number
  /** Row events this soon after an explicit refresh are taken as already covered by it. */
  coveredMs: number
  refresh: () => void
  now: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

export interface Coalescer {
  /** A row changed in the database. */
  rowChanged(): void
  /** The app just refreshed screens itself. */
  refreshed(): void
  dispose(): void
}

export function createCoalescer(o: CoalescerOptions): Coalescer {
  let timer: unknown = null
  let burstStart = 0
  /** The last refresh the app made itself (not one of ours). */
  let lastExplicit = Number.NEGATIVE_INFINITY
  return {
    rowChanged() {
      if (timer !== null) return
      burstStart = o.now()
      timer = o.setTimer(() => {
        timer = null
        if (burstStart - lastExplicit <= o.coveredMs) return
        o.refresh()
      }, o.delayMs)
    },
    refreshed() {
      lastExplicit = o.now()
    },
    dispose() {
      if (timer !== null) o.clearTimer(timer)
      timer = null
    },
  }
}
