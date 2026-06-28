'use client'

/**
 * One bullet in the stream. Ink lives in the writing column (Newsreader); the agent's structure
 * hangs in the margin as rapid-logging glyphs + settled labels (— sleep · 5h, ○ run · 4 km).
 *
 *  - while the worker is reading a just-logged bullet → a pulsing "·" and "reading…"
 *  - once entities land → the representative glyph + each applied entity as a muted margin label
 *  - pending suggestions → a "N to review" pill that jumps to the Review inbox
 *
 * Editing a bullet calls `bullets.update`, which re-runs extraction and reconciles (§4.7).
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useState } from 'react'
import { GLYPH } from '@/lib/design'
import { formatTime } from '@/lib/format'
import { useTRPC } from '@/lib/trpc'
import type { Bullet } from '@/lib/types'
import { bulletGlyph, marginLabel, type NormalizedEntity } from '@/lib/view-model'

interface Props {
  bullet: Bullet
  entities: NormalizedEntity[]
  pendingCount: number
  processing: boolean
}

function resolveGlyph(entities: NormalizedEntity[], processing: boolean) {
  if (processing && entities.length === 0)
    return { glyph: GLYPH.processing, colorClass: 'text-faint-4', pulse: true }
  if (entities.length > 0) return { ...bulletGlyph(entities), pulse: false }
  return { glyph: GLYPH.note, colorClass: 'text-faint-3', pulse: false }
}

export function BulletRow({ bullet, entities, pendingCount, processing }: Props) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(bullet.text)

  const update = useMutation(
    trpc.bullets.update.mutationOptions({
      onSuccess: () => {
        setEditing(false)
        void queryClient.invalidateQueries()
      },
    }),
  )

  const { glyph, colorClass, pulse } = resolveGlyph(entities, processing)
  const labels = entities.map((e) => ({ id: e.id, text: marginLabel(e) }))

  function saveEdit() {
    const next = text.trim()
    if (!next || next === bullet.text) {
      setEditing(false)
      setText(bullet.text)
      return
    }
    update.mutate({ id: bullet.id, text: next })
  }

  // Shared inner content for the writing column.
  const writing = editing ? (
    <div className="flex-1">
      <textarea
        // biome-ignore lint/a11y/noAutofocus: focus the field the user just chose to edit
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            saveEdit()
          }
          if (e.key === 'Escape') {
            setEditing(false)
            setText(bullet.text)
          }
        }}
        rows={2}
        className="w-full resize-none rounded-lg border border-indigo-line bg-white px-2 py-1 font-reader text-[19px] text-ink leading-relaxed outline-none focus:border-indigo"
      />
      <div className="mt-1 flex items-center gap-3 font-data text-[11px]">
        <button
          type="button"
          onClick={saveEdit}
          disabled={update.isPending}
          className="text-indigo hover:underline"
        >
          {update.isPending ? 'saving…' : 'save · re-runs extraction'}
        </button>
        <button
          type="button"
          onClick={() => {
            setEditing(false)
            setText(bullet.text)
          }}
          className="text-faint"
        >
          cancel
        </button>
      </div>
    </div>
  ) : (
    <span className="flex-1 font-reader text-[19px] text-ink leading-relaxed">{bullet.text}</span>
  )

  const editButton = !editing && (
    <button
      type="button"
      title="Edit bullet"
      onClick={() => setEditing(true)}
      className="flex-none pl-3 text-[14px] text-faint-3 opacity-0 transition-opacity hover:text-indigo group-hover:opacity-100"
    >
      ✎
    </button>
  )

  const margin = (
    <>
      <span className="font-data text-[11px] text-faint-2">{formatTime(bullet.created_at)}</span>
      {processing && entities.length === 0 ? (
        <span className="animate-dotpulse font-data text-[12px] text-faint-4">reading…</span>
      ) : (
        labels.map((l) => (
          <span key={l.id} className="font-data text-[13px] text-faint-2">
            {l.text}
          </span>
        ))
      )}
      {pendingCount > 0 && (
        <Link
          href="/review"
          className="inline-flex items-center gap-[6px] rounded-[20px] border border-indigo-soft px-[10px] py-[3px] font-ui text-[12px] text-indigo transition-colors hover:border-indigo hover:bg-indigo-wash"
        >
          <span className="font-data">•</span> {pendingCount} to review
        </Link>
      )}
    </>
  )

  return (
    <div className="group">
      {/* Desktop — structure in the margin */}
      <div className="hidden md:grid md:grid-cols-[210px_1fr] md:gap-x-[38px] md:py-[11px]">
        <div className="flex flex-col items-end gap-[6px] pt-[2px] text-right">{margin}</div>
        <div className="-ml-[19px] border-line border-l pl-6">
          <div className="flex items-baseline gap-0">
            <span
              className={`-ml-[2px] w-[22px] flex-none font-data text-[15px] ${colorClass} ${pulse ? 'animate-dotpulse' : ''}`}
            >
              {glyph}
            </span>
            {writing}
            {editButton}
          </div>
        </div>
      </div>

      {/* Mobile — folded gutter */}
      <div className="flex gap-[13px] py-[9px] md:hidden">
        <div
          className={`w-4 flex-none text-center font-data text-[15px] leading-[1.6] ${colorClass}`}
        >
          <span className={pulse ? 'animate-dotpulse inline-block' : ''}>{glyph}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1">
              {editing ? (
                writing
              ) : (
                <div className="font-reader text-[16.5px] text-ink leading-snug">{bullet.text}</div>
              )}
            </div>
            {!editing && (
              <button
                type="button"
                title="Edit bullet"
                onClick={() => setEditing(true)}
                className="flex-none pl-1 text-[13px] text-faint-3 hover:text-indigo"
              >
                ✎
              </button>
            )}
          </div>
          <div className="mt-[5px] flex flex-wrap items-center gap-[9px]">{margin}</div>
        </div>
      </div>
    </div>
  )
}
