/** Journal · stream: captures grouped by day, newest first, loaded a page at a time. */

import {
  AUDIO_READ_ERROR_TEXT,
  type CaptureCard as Card,
  cardAccessibilityLabel,
  cardState,
  groupByDay,
  listCaptureCards,
  openThemeLabel,
  plural,
  sourceLine,
} from '@bullet/client'
import { useState } from 'react'
import { useLocalQuery } from '../app/hooks'
import { useActions, useNav } from '../app/nav'
import { Bidi, Button, EmptyNote, KindPill, NavList, SectionTitle } from '../ui/primitives'
import { KIND_LABELS } from '@bullet/client/theme'

const PAGE = 40

export function Stream() {
  const nav = useNav()
  const [limit, setLimit] = useState(PAGE)
  const page = useLocalQuery((db) => listCaptureCards(db, limit), limit)
  // Days and times read in each capture's own zone (where you were), like its card's time.
  const sections = groupByDay(
    page.cards,
    (c) => c.capturedAt,
    Date.now(),
    (c) => c.timezone,
  )
  if (sections.length === 0) {
    return <EmptyNote>Your captures will show up here, grouped by day.</EmptyNote>
  }
  return (
    <div className="stream">
      {sections.map((section) => (
        <section key={section.key} aria-label={section.title}>
          <SectionTitle>{section.title}</SectionTitle>
          <NavList className="cards">
            {section.data.map((card) => (
              <li key={card.id}>
                <CaptureCard
                  card={card}
                  onOpen={() => nav.openPanel({ kind: 'capture', id: card.id })}
                  selected={nav.route.panel?.kind === 'capture' && nav.route.panel.id === card.id}
                />
              </li>
            ))}
          </NavList>
        </section>
      ))}
      {page.hasMore ? (
        <div className="more">
          <Button variant="option" onClick={() => setLimit((l) => l + PAGE)}>
            Show earlier captures
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/** A capture in the stream: source, time, state, and its thoughts with kind labels. */
function CaptureCard({
  card,
  onOpen,
  selected,
}: {
  card: Card
  onOpen: () => void
  selected: boolean
}) {
  const nav = useNav()
  const actions = useActions()
  const state = cardState(card)
  const showThoughts = card.thoughts.length > 0
  const about = card.thinkingAbout
  return (
    <article className={`card capture-card${selected ? ' is-selected' : ''}`}>
      {about ? (
        <p className="thinking-about">
          <span className="caption">Thinking about</span>{' '}
          <Bidi text={about.text} className="question-text" />
        </p>
      ) : null}
      <div className="card-top">
        <button
          type="button"
          className="card-open"
          data-nav
          aria-label={cardAccessibilityLabel(card)}
          aria-current={selected ? 'true' : undefined}
          onClick={onOpen}
        >
          <span className="source">
            {card.source === 'voice' ? <span aria-hidden="true">▶ </span> : null}
            {sourceLine(card)}
          </span>
          <span className={`state tone-${state.tone}`}>
            {state.onPhone ? <span aria-hidden="true">⌂ </span> : null}
            {state.label === 'Done' && showThoughts
              ? plural(card.thoughts.length, 'thought')
              : state.label}
          </span>
        </button>
      </div>
      {showThoughts ? (
        <ul className="thoughts">
          {card.thoughts.map((th) => (
            <li key={th.id} className="thought-line">
              <KindPill kind={th.kind} label={KIND_LABELS[th.kind]} />
              <Bidi text={th.text} className="thought-text" />
              {th.themeId ? (
                <button
                  type="button"
                  className="again-dot"
                  aria-label={openThemeLabel(th.text)}
                  title="Comes up again"
                  onClick={() => th.themeId && nav.openPanel({ kind: 'theme', id: th.themeId })}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <Bidi as="p" text={card.text} className="card-text clamp" />
      )}
      {card.audioReadError ? <p className="caption">{AUDIO_READ_ERROR_TEXT}</p> : null}
      {state.untranscribable ? (
        <div className="card-extra">
          <p className="caption">{state.reason}</p>
          <div className="row">
            <Button onClick={() => nav.openPanel({ kind: 'capture', id: card.id, write: true })}>
              Write it down
            </Button>
            <Button variant="quiet" onClick={() => actions.keepAsAudio(card.id)}>
              Keep as audio
            </Button>
          </div>
        </div>
      ) : null}
      {state.retry ? (
        <div className="card-extra row">
          <p className="caption grow">{state.reason}</p>
          <Button aria-label="Retry this capture" onClick={() => actions.retryCaptures([card.id])}>
            Retry
          </Button>
        </div>
      ) : null}
    </article>
  )
}
