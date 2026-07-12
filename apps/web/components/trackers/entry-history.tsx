'use client'

/**
 * The entry history for a tracker's detail view — every logged reading, newest first, with its
 * value, when it landed, and its provenance: an extracted entry keeps the "↳ from your journal"
 * thread back to its bullet (reusing the shared `Provenance`), a hand-logged one reads "✎ manual".
 * Each row can be soft-deleted.
 */

import { useState } from 'react'
import { Provenance } from '@/components/overview/provenance'
import { historyRows } from '@/lib/trackers-view-model'
import type { Bullet, Tracker, TrackerEntry } from '@/lib/types'

export function EntryHistory({
  entries,
  tracker,
  bulletsById,
  busy,
  onDelete,
  heading = 'History',
}: {
  entries: TrackerEntry[]
  tracker: Tracker
  bulletsById: Map<string, Bullet>
  busy: boolean
  onDelete: (id: string) => void
  heading?: string
}) {
  const rows = historyRows(entries, tracker)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  if (rows.length === 0) return null

  return (
    <div className="mt-8">
      <div className="mb-1 font-data text-[10.5px] text-faint-2 uppercase tracking-[0.12em]">
        {heading}
      </div>
      {rows.map((row) => (
        <div
          key={row.id}
          className="flex items-start gap-[14px] border-line-soft border-t py-[14px]"
        >
          <div className="w-[78px] flex-none pt-[2px] text-right">
            <div className="font-ui text-[13px] text-ink">{row.day}</div>
            <div className="mt-[1px] font-data text-[10.5px] text-faint-3">{row.time}</div>
          </div>
          <div className="min-w-0 flex-1">
            {row.isText ? (
              <div className="font-reader text-[17px] text-ink leading-snug">{row.value}</div>
            ) : (
              <span className="inline-flex items-center gap-[7px] rounded-[8px] bg-ochre-wash px-3 py-[5px] font-ui text-[13.5px] text-ochre">
                <span className="h-2 w-2 rounded-full bg-ochre" />
                {row.value}
              </span>
            )}
            <div className="mt-[6px]">
              {row.extracted && row.sourceBulletId ? (
                <Provenance bullet={bulletsById.get(row.sourceBulletId)} />
              ) : (
                <span className="font-data text-[10.5px] text-faint-3">✎ manual</span>
              )}
            </div>
          </div>
          {confirmId === row.id ? (
            <span className="flex-none items-center gap-2 font-ui text-[12px] text-muted-soft">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  onDelete(row.id)
                  setConfirmId(null)
                }}
                className="font-medium text-rust hover:underline disabled:opacity-50"
              >
                Delete
              </button>{' '}
              <button
                type="button"
                onClick={() => setConfirmId(null)}
                className="text-faint hover:text-muted-soft"
              >
                Keep
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmId(row.id)}
              aria-label={`Delete entry from ${row.day}`}
              className="flex-none font-data text-[13px] text-faint-3 transition-colors hover:text-rust"
            >
              ✕
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
