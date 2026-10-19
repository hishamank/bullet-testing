/**
 * Inbox: To decide (grouped by capture, and "Did this close it?"), To clarify (clarifying
 * questions, in the badge), To think about (reflective questions, never in the badge), Noticed
 * (themes, never in the badge) and Done for you today. Everything here is optional and can wait;
 * the screen only wires clicks to `rt.inbox` and the actions.
 */

import {
  closeAskLabel,
  COPY,
  type DoneItem,
  inboxSections,
  type LoopAnswerCard,
  type NoticedCard as NoticedData,
  type QuestionItem,
  quote,
  toDecideCount,
  UNDO_MESSAGES,
  type AnsweredCard,
  type ThinkCard as ThinkData,
} from '@bullet/client'
import { CONNECTION_OPTIONS } from '@bullet/core'
import { useEffect, useState } from 'react'
import { useInbox, useLoopAnswers, useNoticed, useRuntime, useThinkView } from '../app/hooks'
import { useActions, useNav } from '../app/nav'
import { Bidi, Button, Disclosure, NavList, Note, Quoted, SectionTitle } from '../ui/primitives'
import { CaptureLink, DecideGroup } from './DecideGroup'

/** How long a one-off message (e.g. "it stays dismissed") stays before fading out. */
const MESSAGE_MS = 6_000

export function Inbox() {
  const rt = useRuntime()
  const nav = useNav()
  const view = useInbox()
  const think = useThinkView()
  const loopAnswers = useLoopAnswers()
  const noticed = useNoticed()
  const [message, setMessage] = useState<string | null>(null)
  const sections = inboxSections(view.empty, loopAnswers.length, noticed.length)
  const deciding = toDecideCount(view.pendingCount, loopAnswers)
  const openCapture = (id: string) => nav.openPanel({ kind: 'capture', id })

  // Leaving the Inbox sends whatever is still in its Undo window.
  useEffect(() => () => rt.inbox.flushDecisions(), [rt])
  useEffect(() => {
    if (!message) return
    const id = setTimeout(() => setMessage(null), MESSAGE_MS)
    return () => clearTimeout(id)
  }, [message])

  const onUndo = (id: string) => {
    if (rt.inbox.undoDecision(id) === 'already_sent') setMessage(UNDO_MESSAGES.already_sent)
  }

  return (
    <div className="inbox">
      {view.notices.map((n) => (
        <Note key={n.key} text={n.text} onDismiss={() => rt.inbox.dismissNotice(n.key)} />
      ))}
      {message ? <Note text={message} onDismiss={() => setMessage(null)} /> : null}

      {sections.empty ? (
        <section className="empty-state">
          <h2>Nothing waiting.</h2>
          <p className="secondary">Captures you make will show up here when they need you.</p>
          <Button onClick={() => nav.openPanel({ kind: 'pick' })}>Pick a question</Button>
        </section>
      ) : null}

      {view.groups.length > 0 || loopAnswers.length > 0 ? (
        <section aria-label="To decide">
          <SectionTitle count={deciding > 0 ? deciding : undefined}>To decide</SectionTitle>
          {loopAnswers.map((a) => (
            <LoopAnswer key={a.suggestionId} item={a} onOpenCapture={openCapture} onUndo={onUndo} />
          ))}
          {view.groups.map((g) => (
            <DecideGroup key={g.bulletId} group={g} />
          ))}
        </section>
      ) : null}

      {view.questions.length > 0 ? (
        <section aria-label="To clarify">
          <SectionTitle count={view.questions.length}>To clarify</SectionTitle>
          {view.questions.map((q) => (
            <QuestionCard key={q.id} question={q} />
          ))}
        </section>
      ) : null}

      {sections.think ? (
        <section aria-label="To think about">
          <SectionTitle count={think.toThink.length > 0 ? think.toThink.length : undefined}>
            To think about
          </SectionTitle>
          {think.toThink.length > 0 ? (
            think.toThink.map((q) => <ThinkCard key={q.id} question={q} />)
          ) : (
            <div className="card stack-sm">
              <p>Nothing to think about right now.</p>
              <div className="row">
                <Button onClick={() => nav.openPanel({ kind: 'pick' })}>Pick a question</Button>
              </div>
            </div>
          )}
        </section>
      ) : null}
      <AnsweredList
        items={think.answered}
        onAddMore={(q) => nav.openPanel({ kind: 'answer', target: 'question', id: q.id })}
      />

      {sections.empty ? null : (
        <section aria-label={COPY.noticedTitle}>
          <SectionTitle>{COPY.noticedTitle}</SectionTitle>
          {noticed.length > 0 ? (
            noticed.map((c) => <NoticedCard key={c.id} card={c} onOpenCapture={openCapture} />)
          ) : (
            <div className="card">
              <p className="secondary">{COPY.noticedEmpty}</p>
            </div>
          )}
        </section>
      )}

      {view.done.length > 0 ? (
        <section aria-label="Done for you today">
          <SectionTitle count={view.done.length}>Done for you today</SectionTitle>
          <DoneList items={view.done} />
        </section>
      ) : null}
    </div>
  )
}

function QuestionCard({ question }: { question: QuestionItem }) {
  const rt = useRuntime()
  const nav = useNav()
  return (
    <article className="card stack-sm">
      <CaptureLink
        bulletId={question.bulletId}
        snippet={question.snippet}
        source={question.source}
      />
      <p>{question.text}</p>
      <div className="row wrap">
        {question.options.map((o) => (
          <Button
            key={o}
            variant="option"
            data-nav
            aria-label={`Answer ${o}, to: ${question.text}`}
            onClick={() => rt.inbox.answerWithOption(question.id, o)}
          >
            {o}
          </Button>
        ))}
        <Button
          aria-label={`Answer in words: ${question.text}`}
          onClick={() => nav.openPanel({ kind: 'answer', target: 'question', id: question.id })}
        >
          Answer in words
        </Button>
        <Button
          variant="quiet"
          aria-label={`Skip: ${question.text}`}
          onClick={() => rt.inbox.skipQuestion(question.id)}
        >
          Skip
        </Button>
      </div>
    </article>
  )
}

/**
 * "To think about": a reflective question with Journal about it, Later and Not this one; a
 * connection question also asks Same thing / Different.
 */
function ThinkCard({ question }: { question: ThinkData }) {
  const nav = useNav()
  const actions = useActions()
  const connection = question.origin === 'connection'
  return (
    <article className="card stack-sm">
      <Bidi as="p" text={question.text} className="question-text" />
      {question.sourceLine ? <p className="caption">{question.sourceLine}</p> : null}
      {connection ? (
        <div className="row wrap">
          <Button
            variant="option"
            aria-label={`${CONNECTION_OPTIONS[0]}: ${question.text}`}
            onClick={() => actions.answerSame(question.id, true)}
          >
            {CONNECTION_OPTIONS[0]}
          </Button>
          <Button
            variant="option"
            aria-label={`${CONNECTION_OPTIONS[1]}: ${question.text}`}
            onClick={() => actions.answerSame(question.id, false)}
          >
            {CONNECTION_OPTIONS[1]}
          </Button>
        </div>
      ) : null}
      <div className="row wrap">
        <Button
          variant="primary"
          data-nav
          aria-label={`Journal about it: ${question.text}`}
          onClick={() => nav.openPanel({ kind: 'answer', target: 'question', id: question.id })}
        >
          Journal about it
        </Button>
        <Button
          aria-label={`Later: ${question.text}`}
          title="Hides it for a week"
          onClick={() => actions.laterQuestion(question.id)}
        >
          Later
        </Button>
        <Button
          variant="quiet"
          aria-label={`Not this one: ${question.text}`}
          title="Removes it for good"
          onClick={() => actions.notThisOne(question.id)}
        >
          Not this one
        </Button>
      </div>
    </article>
  )
}

/** "Answered · N", collapsed until opened; each answered question offers "Add more". */
function AnsweredList({
  items,
  onAddMore,
}: {
  items: readonly AnsweredCard[]
  onAddMore: (item: AnsweredCard) => void
}) {
  const [open, setOpen] = useState(false)
  if (items.length === 0) return null
  return (
    <section aria-label="Answered">
      <Disclosure
        title={`Answered · ${items.length}`}
        open={open}
        onToggle={() => setOpen((o) => !o)}
      />
      {open
        ? items.map((q) => (
            <article key={q.id} className="card stack-sm">
              <Bidi as="p" text={q.text} className="question-text" />
              <p className="caption">
                {[q.sourceLine, q.answers === 1 ? '1 answer' : `${q.answers} answers`]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              <div className="row">
                <Button aria-label={`Add more: ${q.text}`} onClick={() => onAddMore(q)}>
                  Add more
                </Button>
              </div>
            </article>
          ))
        : null}
    </section>
  )
}

/**
 * "Did this close it?": «loop» ← «answer», Close it / Keep open (with the usual Undo window), or
 * "Already closed".
 */
function LoopAnswer({
  item,
  onOpenCapture,
  onUndo,
}: {
  item: LoopAnswerCard
  onOpenCapture: (bulletId: string) => void
  onUndo: (suggestionId: string) => void
}) {
  const actions = useActions()
  const label = closeAskLabel(item.loop, item.answer)
  return (
    <article className="card stack-sm" aria-label={label}>
      <h3 className="card-title">{COPY.closeAsk}</h3>
      <button
        type="button"
        className="quote-link"
        data-nav
        aria-label={`Open loop: ${quote(item.loop)}`}
        title={COPY.quoteHint}
        onClick={() => onOpenCapture(item.loopBulletId)}
      >
        <Quoted text={item.loop} rtl={item.loopRtl} />
      </button>
      {item.answer ? (
        <button
          type="button"
          className="quote-link answer"
          data-nav
          aria-label={`Answered by ${quote(item.answer)}`}
          title={COPY.quoteHint}
          onClick={() => onOpenCapture(item.answerBulletId)}
        >
          <span aria-hidden="true">←</span> <Quoted text={item.answer} rtl={item.answerRtl} />
        </button>
      ) : null}
      {item.decision ? (
        <div className="row end" aria-live="polite">
          <span className="secondary grow">
            {item.decision === 'accepted' ? COPY.closed : COPY.keptOpen}
          </span>
          <Button
            data-nav
            aria-label={`${COPY.undo}: ${quote(item.loop)}`}
            onClick={() => onUndo(item.suggestionId)}
          >
            {COPY.undo}
          </Button>
        </div>
      ) : item.alreadyClosed ? (
        <div className="row end">
          <span className="muted grow">{COPY.alreadyClosed}</span>
          <Button
            data-nav
            aria-label={`${COPY.alreadyClosed}. ${COPY.ok}`}
            onClick={() => actions.clearClosed(item.suggestionId)}
          >
            {COPY.ok}
          </Button>
        </div>
      ) : (
        <div className="row end">
          <Button
            variant="option"
            data-nav
            aria-label={`${COPY.keepOpen}: ${quote(item.loop)}`}
            onClick={() => actions.keepLoopOpen(item.suggestionId)}
          >
            {COPY.keepOpen}
          </Button>
          <Button
            variant="option"
            data-nav
            aria-label={`${COPY.closeIt}: ${quote(item.loop)}`}
            onClick={() => actions.closeLoop(item.suggestionId)}
          >
            {COPY.closeIt}
          </Button>
        </div>
      )}
    </article>
  )
}

/** A Noticed card: «quote» · came up N times, the editable theme pill, and its actions. */
function NoticedCard({
  card,
  onOpenCapture,
}: {
  card: NoticedData
  onOpenCapture: (bulletId: string) => void
}) {
  const nav = useNav()
  const actions = useActions()
  const [renaming, setRenaming] = useState<string | null>(null)
  const saveName = () => {
    if (renaming !== null && actions.renameThemeTo(card.theme.id, renaming)) setRenaming(null)
  }
  return (
    <article className="card stack-sm">
      {renaming === null ? (
        <button
          type="button"
          className="theme-pill"
          aria-label={
            card.theme.name
              ? `Theme: ${card.theme.name}. Rename`
              : `Theme without a name. ${COPY.unnamed}`
          }
          onClick={() => setRenaming(card.theme.name ?? '')}
        >
          {card.theme.name ?? COPY.unnamed} ✎
        </button>
      ) : (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            saveName()
          }}
        >
          <label className="field grow">
            <span className="visually-hidden">{COPY.renameField}</span>
            <input
              type="text"
              // oxlint-disable-next-line jsx-a11y/no-autofocus -- the user just chose Rename
              autoFocus
              maxLength={60}
              value={renaming}
              placeholder={COPY.renameField}
              onChange={(e) => setRenaming(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  setRenaming(null)
                }
              }}
            />
          </label>
          <Button variant="primary" type="submit" disabled={renaming.trim() === ''}>
            {COPY.save}
          </Button>
          <Button variant="quiet" onClick={() => setRenaming(null)}>
            {COPY.cancel}
          </Button>
        </form>
      )}
      <Bidi as="p" text={card.headline} className="headline" />
      <NavList className="quotes">
        {card.quotes.map((q) => (
          <li key={q.thoughtId}>
            <button
              type="button"
              className="quote-link"
              data-nav
              aria-label={q.label}
              title={COPY.quoteHint}
              onClick={() => onOpenCapture(q.bulletId)}
            >
              <Quoted text={q.text} rtl={q.rtl} />
              {q.when ? <span className="caption">{q.when}</span> : null}
            </button>
          </li>
        ))}
      </NavList>
      <div className="row wrap">
        <Button
          variant="option"
          title={COPY.openHint}
          aria-label={`${COPY.open}: ${card.headline}`}
          onClick={() => {
            actions.openCard(card.id)
            nav.openPanel({ kind: 'theme', id: card.theme.id })
          }}
        >
          {COPY.open}
        </Button>
        <Button
          title={COPY.notAThemeHint}
          aria-label={`${COPY.notATheme}: ${card.headline}`}
          onClick={() => actions.notATheme(card.theme.id)}
        >
          {COPY.notATheme}
        </Button>
        <Button
          title={COPY.clearHint}
          aria-label={`${COPY.clear}: ${card.headline}`}
          onClick={() => actions.dismissCard(card.id)}
        >
          {COPY.clear}
        </Button>
        <Button variant="quiet" onClick={() => setRenaming(card.theme.name ?? '')}>
          {COPY.rename}
        </Button>
        <Button variant="quiet" onClick={() => nav.openPanel({ kind: 'merge', id: card.theme.id })}>
          {COPY.mergeWith}
        </Button>
      </div>
    </article>
  )
}

/** Done for you today: what was applied automatically or by a tapped answer, each with Undo. */
function DoneList({ items }: { items: DoneItem[] }) {
  const rt = useRuntime()
  return (
    <ul className="rows card">
      {items.map((item) => (
        <li key={item.suggestionId} className="row-item">
          <div className="row-main">
            <span className="secondary">{item.summary.done}</span>
            {item.viaQuestion || !item.confirmed ? (
              <span className="caption">{doneNote(item)}</span>
            ) : null}
            <CaptureLink bulletId={item.bulletId} snippet={item.snippet} source={item.source} />
          </div>
          <Button
            data-nav
            aria-label={`Undo: ${item.summary.done}`}
            onClick={() => rt.inbox.undoApplied(item.suggestionId, item.summary.done)}
          >
            Undo
          </Button>
        </li>
      ))}
    </ul>
  )
}

/** "From your answer", "On this device · will sync", or both. */
function doneNote(item: DoneItem): string {
  const parts = [
    item.viaQuestion ? 'From your answer' : null,
    item.confirmed ? null : 'on this device · will sync',
  ]
  const text = parts.filter(Boolean).join(' · ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}
