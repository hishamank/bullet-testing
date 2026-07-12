'use client'

/**
 * The "quiet pattern" card — an honest same-day co-occurrence read: a scale/number tracker's mean
 * on days a given activity happened vs. days it didn't. It renders ONLY when the backend found a
 * pattern clearing the minimum-sample threshold on both sides; otherwise the page hides it. No
 * significance claim — just the two means, the gap, and how many days back each side.
 */

import type { Correlation } from '@/lib/types'

const round1 = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1))

/**
 * Phrase the gap the way the design does — "about half a point higher", plainly, with the honest
 * day counts. No p-values, no "significant": just the observed means and how much data backs them.
 */
export function patternSentence(c: Correlation): string {
  const gap = Math.abs(c.delta)
  const dir = c.delta >= 0 ? 'higher' : 'lower'
  const magnitude =
    gap < 0.35 ? 'a touch' : gap < 0.75 ? 'about half a point' : `about ${round1(gap)} points`
  return `Your ${c.trackerName.toLowerCase()} runs ${magnitude} ${dir} on days you logged ${c.activityName.trim().toLowerCase()} — ${c.withDays} days with it, ${c.withoutDays} without.`
}

export function QuietPattern({ correlation }: { correlation: Correlation }) {
  return (
    <div className="mt-[26px] flex max-w-[720px] items-start gap-[13px] rounded-[12px] border border-line bg-white px-[18px] py-4">
      <span className="mt-[1px] font-data text-[15px] text-ochre">∿</span>
      <div>
        <div className="mb-1 font-data text-[9.5px] text-faint-2 uppercase tracking-[0.14em]">
          A quiet pattern
        </div>
        <div className="font-reader text-[16px] text-ink-deep leading-relaxed">
          {patternSentence(correlation)}
        </div>
      </div>
    </div>
  )
}
