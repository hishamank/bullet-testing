/**
 * Answer: the capture box with a question (a clarifying one, or a reflective one from "Journal about
 * it" / "Add more") or an open loop pinned on top. The answer is saved as a capture; a loop's note
 * also closes the loop. A reflective question may be answered again and again.
 */

import { findPinned, fromLabel, questionSourceLine } from '@bullet/client'
import { useState } from 'react'
import { useLocalQuery } from '../app/hooks'
import { useActions, useNav } from '../app/nav'
import { CaptureBox } from '../screens/CaptureBox'
import { Bidi } from '../ui/primitives'
import { PanelFrame, PanelGone } from './PanelFrame'

export function AnswerPanel({ target, id }: { target: 'question' | 'thought'; id: string }) {
  const nav = useNav()
  const actions = useActions()
  const live = useLocalQuery(
    (db) => findPinned(db, target === 'question' ? { question: id } : { thought: id }),
    `${target}|${id}`,
  )
  // Answering closes the question; keep showing it while "Saved" plays out.
  const [opened] = useState(live)
  const pinned = live ?? opened

  if (!pinned) {
    return (
      <PanelFrame title="Answer">
        <PanelGone>This was already answered or closed.</PanelGone>
      </PanelFrame>
    )
  }
  const heading = pinned.reflective
    ? 'Thinking about'
    : pinned.kind === 'question'
      ? 'Answering'
      : 'Closing with a note'
  const from = pinned.reflective
    ? questionSourceLine(pinned.origin ?? 'evergreen', pinned.source, Date.now())
    : pinned.source
      ? fromLabel(pinned.source, Date.now())
      : null
  return (
    <PanelFrame title={heading}>
      <CaptureBox
        size="bar"
        autoFocus
        label="Your answer"
        placeholder={pinned.reflective ? 'Start anywhere…' : 'Your answer…'}
        pinned={
          <div
            className={`about ${pinned.kind === 'question' ? 'kind-question' : 'kind-to-check'}`}
          >
            <Bidi
              as="p"
              text={pinned.text}
              className={pinned.reflective ? 'question-text' : undefined}
            />
            {from ? <p className="caption">{from}</p> : null}
          </div>
        }
        status={<span className="status-text">Your answer is saved as a capture too.</span>}
        onSend={(text, attempt) => {
          // A loop's note is a capture that resolves the thought (`resolves_thought_id`).
          return pinned.kind === 'loop'
            ? actions.sendLoopNote(text, pinned.id, attempt)
            : actions.sendCapture(text, attempt, { answersQuestionId: pinned.id })
        }}
        onAbandon={actions.abandonSend}
        onSavedShown={() => nav.closePanel()}
      />
    </PanelFrame>
  )
}
