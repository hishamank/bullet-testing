'use client'

/**
 * The provenance thread — every extracted entity keeps a link back to the bullet that created it.
 * Renders the design's "↳ from your journal" affordance: a quiet button that expands the source
 * bullet (italic quote + timestamp) with a jump into the Timeline.
 */

import Link from 'next/link'
import { useState } from 'react'
import { formatTime, shortDay } from '@/lib/format'
import type { Bullet } from '@/lib/types'

export function Provenance({ bullet }: { bullet?: Bullet }) {
  const [open, setOpen] = useState(false)
  if (!bullet) return null

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="mt-[5px] inline-flex items-center gap-[5px] font-data text-[11px] text-faint-2 transition-colors hover:text-indigo"
      >
        ↳ from your journal · {shortDay(bullet.created_at)} {formatTime(bullet.created_at)}
      </button>
      {open && (
        <div className="mt-[9px] rounded-r-[10px] border border-line border-l-2 border-l-indigo-soft bg-panel px-[14px] py-[11px]">
          <div className="mb-[5px] font-data text-[10px] text-faint-3 tracking-[0.06em]">
            {shortDay(bullet.created_at)} · {formatTime(bullet.created_at)}
          </div>
          <div className="font-reader text-[15px] text-muted italic leading-relaxed">
            “{bullet.text}”
          </div>
          <Link
            href="/timeline"
            className="mt-[9px] inline-block font-data text-[11px] text-indigo hover:underline"
          >
            Open in Timeline →
          </Link>
        </div>
      )}
    </div>
  )
}
