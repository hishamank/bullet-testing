/**
 * A theme (every capture it came up in), "Merge with…", and "Pick a question". Layout only: the
 * data and the writes are `@bullet/client`.
 */

import { capturesHeading, COPY, PICK_REFUSED_TEXT, themeTitle } from '@bullet/client'
import { useState } from 'react'
import { useEvergreenChoices, useMergeChoices, useThemeView } from '../app/hooks'
import { useActions, useNav } from '../app/nav'
import { Button, NavList, Quoted, SectionTitle } from '../ui/primitives'
import { PanelFrame, PanelGone } from './PanelFrame'

/** A theme: every capture it came up in, newest first. Rename, Merge with… and Not a theme. */
export function ThemePanel({ id }: { id: string }) {
  const nav = useNav()
  const actions = useActions()
  const theme = useThemeView(id)
  const [renaming, setRenaming] = useState<string | null>(null)
  if (!theme) {
    return (
      <PanelFrame title="Theme">
        <PanelGone>{COPY.themeGone}</PanelGone>
      </PanelFrame>
    )
  }
  const save = () => {
    if (renaming !== null && actions.renameThemeTo(theme.id, renaming)) setRenaming(null)
  }
  return (
    <PanelFrame title={themeTitle(theme.name)}>
      {renaming === null ? (
        <div className="row">
          <button
            type="button"
            className="theme-pill"
            aria-label={
              theme.name ? `Theme: ${theme.name}. Rename` : `Theme without a name. ${COPY.unnamed}`
            }
            onClick={() => setRenaming(theme.name ?? '')}
          >
            {theme.name ?? COPY.unnamed} ✎
          </button>
        </div>
      ) : (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            save()
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
      <SectionTitle level={3}>{capturesHeading(theme.captures.length)}</SectionTitle>
      <NavList className="rows card">
        {theme.captures.map((q) => (
          <li key={q.thoughtId} className="row-item">
            <button
              type="button"
              className="row-main"
              data-nav
              aria-label={q.label}
              title={COPY.quoteHint}
              onClick={() => nav.openPanel({ kind: 'capture', id: q.bulletId })}
            >
              <Quoted text={q.text} rtl={q.rtl} />
              {q.when ? <span className="caption">{q.when}</span> : null}
            </button>
          </li>
        ))}
      </NavList>
      <div className="row">
        <Button onClick={() => nav.openPanel({ kind: 'merge', id: theme.id })}>
          {COPY.mergeWith}
        </Button>
        <Button
          title={COPY.notAThemeHint}
          onClick={() => {
            actions.notATheme(theme.id)
            nav.closePanel()
          }}
        >
          {COPY.notATheme}
        </Button>
      </div>
    </PanelFrame>
  )
}

/** "Merge with…": the other themes, biggest first. */
export function MergePanel({ id }: { id: string }) {
  const nav = useNav()
  const actions = useActions()
  const choices = useMergeChoices(id)
  return (
    <PanelFrame title={COPY.mergeWith}>
      <p className="secondary">{choices.length > 0 ? COPY.mergeIntro : COPY.mergeEmpty}</p>
      {choices.length > 0 ? (
        <NavList className="rows card">
          {choices.map((c) => (
            <li key={c.id} className="row-item">
              <button
                type="button"
                className="row-main"
                data-nav
                aria-label={`${COPY.mergeWith} ${c.title}, ${c.detail}`}
                onClick={() => {
                  actions.mergeInto(id, c.id)
                  // The merged theme is gone; show the one it joined.
                  nav.openPanel({ kind: 'theme', id: c.id })
                }}
              >
                <span className="row-title">{c.title}</span>
                <span className="caption">{c.detail}</span>
              </button>
            </li>
          ))}
        </NavList>
      ) : null}
    </PanelFrame>
  )
}

/** "Pick a question": the evergreen list. Choosing one opens it to write about. */
export function PickQuestionPanel() {
  const nav = useNav()
  const actions = useActions()
  const evergreen = useEvergreenChoices()
  const [refused, setRefused] = useState(false)
  return (
    <PanelFrame title="Pick a question">
      <p className="secondary">
        Choose one to write or talk about. Your answer is saved like any capture.
      </p>
      {evergreen.canPick ? null : (
        <p className="soft">
          A few questions are already waiting. Answer one, or let one go, to pick another.
        </p>
      )}
      {refused ? <p className="warn">{PICK_REFUSED_TEXT}</p> : null}
      <NavList className="rows card">
        {evergreen.choices.map((q) => (
          <li key={q.id} className="row-item">
            <button
              type="button"
              className="row-main"
              data-nav
              disabled={!evergreen.canPick}
              onClick={() => {
                const questionId = actions.pickQuestion(q.id)
                if (!questionId) {
                  setRefused(true)
                  return
                }
                nav.openPanel({ kind: 'answer', target: 'question', id: questionId })
              }}
            >
              <span className="row-title question-text">{q.text}</span>
            </button>
          </li>
        ))}
      </NavList>
    </PanelFrame>
  )
}
