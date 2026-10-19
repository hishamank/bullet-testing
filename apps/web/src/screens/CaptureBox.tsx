/**
 * The capture box: a multi-line text field, Cmd/Ctrl+Enter (or the Send button) saves, and a quiet
 * "Saved" shows for a moment. The state machine is the phone's (`composerReducer`); on a real
 * keyboard Enter is a new line. One box sits under the content column on every screen, and the
 * Capture screen gives it the whole page.
 */

import { canSend, composerReducer, initialComposer, SAVED_MS } from '@bullet/client'
import { type ReactNode, useEffect, useId, useReducer, useRef, useState } from 'react'
import { isSendShortcut } from '../app/layout'
import { Button } from '../ui/primitives'

const DRAFT_KEY = 'bullet.draft'

function readDraft(key: string | null): string {
  if (!key) return ''
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function writeDraft(key: string | null, text: string) {
  if (!key) return
  try {
    if (text) localStorage.setItem(key, text)
    else localStorage.removeItem(key)
  } catch {
    // Storage blocked: the draft just isn't kept across reloads.
  }
}

export interface CaptureBoxProps {
  /** `page`: the Capture screen, tall. `bar`: under the content column. */
  size: 'page' | 'bar'
  placeholder?: string
  label?: string
  /** Save the capture. Resolves once it is stored in this browser; rejects if it could not be. */
  onSend: (text: string, attempt: string) => Promise<unknown>
  /** A card pinned above the text (the question or loop being answered). */
  pinned?: ReactNode
  /** The quiet line next to Send when nothing was just saved. */
  status?: ReactNode
  /** Keep an unsent draft across reloads (the plain capture box only). */
  keepDraft?: boolean
  autoFocus?: boolean
  /** "Saved" has finished showing. */
  onSavedShown?: () => void
}

export function CaptureBox(p: CaptureBoxProps) {
  const draftKey = p.keepDraft ? DRAFT_KEY : null
  const [state, dispatch] = useReducer(composerReducer, initialComposer, (s) => ({
    ...s,
    text: readDraft(draftKey),
  }))
  const input = useRef<HTMLTextAreaElement>(null)
  const inputId = useId()
  const sending = useRef(false)
  // Names this send until it succeeds, so a retry after a failed store is the same capture.
  const instance = useId()
  const attempt = useRef(0)
  const [problem, setProblem] = useState(false)
  const { savedAt } = state
  const shown = useRef(p.onSavedShown)
  shown.current = p.onSavedShown

  useEffect(() => {
    if (savedAt === null) return
    const id = setTimeout(() => {
      dispatch({ type: 'saved_elapsed', at: savedAt + SAVED_MS })
      shown.current?.()
    }, SAVED_MS)
    return () => clearTimeout(id)
  }, [savedAt])

  useEffect(() => {
    if (p.autoFocus) input.current?.focus()
  }, [p.autoFocus])

  /** "Saved" only shows, and the draft only goes, once the capture is stored in this browser. */
  function send() {
    if (!canSend(state.text) || sending.current) return
    sending.current = true
    setProblem(false)
    p.onSend(state.text, `${instance}:${attempt.current}`).then(
      () => {
        sending.current = false
        attempt.current += 1
        writeDraft(draftKey, '')
        dispatch({ type: 'sent', at: Date.now() })
        input.current?.focus()
      },
      () => {
        sending.current = false
        setProblem(true)
      },
    )
  }

  const saved = savedAt !== null && state.text === ''
  return (
    <section className={`capture-box capture-box-${p.size}`} aria-label="Capture">
      {p.pinned}
      <label className="visually-hidden" htmlFor={inputId}>
        {p.label ?? 'New capture'}
      </label>
      <textarea
        id={inputId}
        ref={input}
        className="capture-input"
        aria-keyshortcuts="Control+Enter Meta+Enter"
        rows={p.size === 'page' ? 8 : 2}
        value={state.text}
        placeholder={p.placeholder ?? "What's on your mind?"}
        onChange={(e) => {
          writeDraft(draftKey, e.target.value)
          setProblem(false)
          dispatch({ type: 'change', text: e.target.value })
        }}
        onFocus={() => dispatch({ type: 'focus' })}
        onBlur={() => dispatch({ type: 'blur' })}
        onKeyDown={(e) => {
          if (isSendShortcut(e)) {
            e.preventDefault()
            send()
          }
        }}
      />
      <div className="capture-bar">
        <div className="capture-status">
          {/* Always mounted, so a screen reader hears "Saved" when it appears. */}
          <span className="saved" role="status" aria-live="polite">
            {saved ? '✓ Saved' : ''}
          </span>
          {problem ? (
            <span className="warn" role="alert">
              Couldn't save this in your browser yet. Your text is still here: try Send again.
            </span>
          ) : saved ? null : (
            p.status
          )}
        </div>
        <span className="hint" aria-hidden="true">
          Ctrl or ⌘ + Enter to send
        </span>
        <Button variant="primary" disabled={!canSend(state.text)} onClick={send}>
          Send
        </Button>
      </div>
    </section>
  )
}
