'use client'

/**
 * The capture composer — a single message-style input (a chat where no one replies). Enter logs
 * the bullet (`bullets.create`, which enqueues extraction on the server); Shift+Enter is a newline.
 * On success it clears, refreshes the stream, and hands the new bullet id up so the row can show
 * its "reading…" state until the agent's extraction event arrives.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { useTRPC } from '@/lib/trpc'

const MAX_TEXTAREA_PX = 120

export function Composer({ onCreated }: { onCreated?: (bulletId: string) => void }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const create = useMutation(
    trpc.bullets.create.mutationOptions({
      onSuccess: (bullet) => {
        setDraft('')
        if (textareaRef.current) textareaRef.current.style.height = 'auto'
        void queryClient.invalidateQueries()
        onCreated?.(bullet.id)
      },
    }),
  )

  function submit() {
    const text = draft.trim()
    if (!text || create.isPending) return
    create.mutate({ text })
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  function handleInput(e: React.FormEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget
    setDraft(el.value)
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`
  }

  return (
    <div>
      <div className="flex items-end gap-3 rounded-[26px] border border-line-warm bg-white px-[22px] py-3 shadow-[0_4px_18px_-8px_rgba(0,0,0,0.12)] transition-shadow focus-within:border-indigo focus-within:shadow-[0_0_0_3px_rgba(62,77,107,0.1)]">
        <span className="pb-[2px] font-data text-[16px] text-faint-4">•</span>
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder="Empty your head…"
          aria-label="Write a bullet"
          className="max-h-[120px] flex-1 resize-none border-none bg-transparent font-reader text-[19px] text-ink leading-relaxed outline-none placeholder:text-faint-3"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!draft.trim() || create.isPending}
          aria-label="Log bullet"
          className="flex h-[38px] w-[38px] flex-none items-center justify-center rounded-full bg-indigo text-[17px] text-white transition-colors hover:bg-indigo-deep disabled:opacity-40"
        >
          ↑
        </button>
      </div>
      <div className="mt-[9px] text-center font-data text-[11px] text-faint-4 tracking-[0.04em]">
        {create.isError
          ? "Couldn't reach the journal server — is it running on :3001?"
          : 'enter to log · shift + enter for a new line · everything stays on this device'}
      </div>
    </div>
  )
}
