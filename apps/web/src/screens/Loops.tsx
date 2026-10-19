/**
 * Journal · open loops: things to check and questions asked to oneself, until closed. Check one
 * off, or close it with a note. Closed ones sit under Done.
 */

import { listLoops, type LoopItem, loopSourceLine } from '@bullet/client'
import { useState } from 'react'
import { useLocalQuery } from '../app/hooks'
import { useActions, useNav } from '../app/nav'
import {
  Bidi,
  Button,
  Checkbox,
  Disclosure,
  EmptyNote,
  NavList,
  SectionTitle,
} from '../ui/primitives'

export function Loops() {
  const nav = useNav()
  const actions = useActions()
  const loops = useLocalQuery(listLoops)
  const [showDone, setShowDone] = useState(false)
  const now = Date.now()
  const open = (l: LoopItem) => nav.openPanel({ kind: 'capture', id: l.bulletId })
  const withNote = (l: LoopItem) => nav.openPanel({ kind: 'answer', target: 'thought', id: l.id })

  const section = (title: string, items: LoopItem[]) =>
    items.length === 0 ? null : (
      <section aria-label={title}>
        <SectionTitle count={items.length}>{title}</SectionTitle>
        <NavList className="rows card">
          {items.map((l) => (
            <li key={l.id} className="row-item">
              <Checkbox
                checked={false}
                label={`Done: ${l.text}`}
                onChange={() => actions.resolveLoop(l.id)}
              />
              <button type="button" className="row-main" data-nav onClick={() => open(l)}>
                <Bidi text={l.text} className="row-title" />
                <span className="caption">{loopSourceLine(l, now)}</span>
              </button>
              <Button
                variant="quiet"
                aria-label={`Close with a note: ${l.text}`}
                onClick={() => withNote(l)}
              >
                Close with a note
              </Button>
            </li>
          ))}
        </NavList>
      </section>
    )

  const nothingOpen = loops.toCheck.length === 0 && loops.questions.length === 0
  return (
    <div className="journal-page">
      <p className="hint-text">
        Things you said you'd look into, and questions you asked yourself. They wait here until you
        come back to them.
      </p>
      {nothingOpen ? <EmptyNote>Nothing open right now.</EmptyNote> : null}
      {section('To check', loops.toCheck)}
      {section('Questions you asked yourself', loops.questions)}
      {loops.done.length > 0 ? (
        <section>
          <Disclosure
            title={`Done · ${loops.done.length}`}
            open={showDone}
            onToggle={() => setShowDone((v) => !v)}
          />
          {showDone ? (
            <NavList className="rows card">
              {loops.done.map((l) => (
                <li key={l.id} className="row-item">
                  <button
                    type="button"
                    className="row-main"
                    data-nav
                    onClick={() =>
                      nav.openPanel({ kind: 'capture', id: l.resolvedByBulletId ?? l.bulletId })
                    }
                  >
                    <Bidi text={l.text} className="row-title struck" />
                    <span className="caption">{l.closedLine}</span>
                  </button>
                  <Button aria-label={`Reopen: ${l.text}`} onClick={() => actions.reopenLoop(l.id)}>
                    Reopen
                  </Button>
                </li>
              ))}
            </NavList>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}
