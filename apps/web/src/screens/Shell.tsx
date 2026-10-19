/**
 * The shell: a slim rail (Capture, Journal, Inbox, sync status) on the left that becomes a bottom
 * tab bar at phone width, a wide content column with the capture box at its bottom, and the
 * right-side panel for Capture detail and Inbox items (over the content on a medium window, a full
 * page on a narrow one).
 */

import { inboxCornerLabel } from '@bullet/client'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useInboxCount, useMediaQuery, useStore, useSyncStatus } from '../app/hooks'
import { NARROW_QUERY, WIDE_QUERY } from '../app/layout'
import { useActions, useNav } from '../app/nav'
import { JOURNAL_TABS, type MainView, formatHash, toView } from '../app/router'
import { UNAUTHORIZED_TEXT, UNREACHABLE_TEXT } from '../app/status'
import { useRuntime } from '../app/hooks'
import { AnswerPanel } from '../panels/AnswerPanel'
import { CaptureDetailPanel } from '../panels/CaptureDetail'
import { EditSuggestionPanel } from '../panels/EditSuggestion'
import { PlanEditPanel } from '../panels/PlanEdit'
import { SettingsPanel } from '../panels/SettingsPanel'
import { MergePanel, PickQuestionPanel, ThemePanel } from '../panels/ThemePanels'
import { ActivityHistoryPanel, TrackerHistoryPanel } from '../panels/TrackerHistory'
import { Button, Note } from '../ui/primitives'
import { CaptureBox } from './CaptureBox'
import { Inbox } from './Inbox'
import { Loops } from './Loops'
import { Plans } from './Plans'
import { StatusLine } from './StatusLine'
import { Stream } from './Stream'
import { Trackers } from './Trackers'

const RECOVERED_TEXT =
  "Your local copy couldn't be read, so it was rebuilt from your home server. A backup of the old copy was kept."

const VIEWS: { view: MainView; label: string }[] = [
  { view: 'capture', label: 'Capture' },
  { view: 'journal', label: 'Journal' },
  { view: 'inbox', label: 'Inbox' },
]

export function Shell() {
  const nav = useNav()
  const actions = useActions()
  const { route } = nav
  const wide = useMediaQuery(WIDE_QUERY)
  const narrow = useMediaQuery(NARROW_QUERY)
  // Beside the content (wide), the content stays usable; over it or instead of it, it doesn't.
  const covered = route.panel !== null && !wide
  const rt = useRuntime()
  const [recoveredShown, setRecoveredShown] = useState(rt.recoveredMirror)

  return (
    <div
      className={`shell view-${route.view}${route.panel ? ' has-panel' : ''}${narrow ? ' is-narrow' : ''}`}
    >
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Rail inert={covered && narrow} />
      <div className="content-column" inert={covered}>
        <Announcer />
        <main id="main" className="content" tabIndex={-1}>
          {recoveredShown ? (
            <Note text={RECOVERED_TEXT} onDismiss={() => setRecoveredShown(false)} />
          ) : null}
          <ServerNotes />
          <View />
        </main>
        <div className="capture-dock">
          <CaptureBox
            key={route.view === 'capture' ? 'page' : 'bar'}
            size={route.view === 'capture' ? 'page' : 'bar'}
            keepDraft
            status={<StatusLine />}
            onSend={(text) => actions.sendCapture(text)}
          />
        </div>
      </div>
      {route.panel ? (
        <>
          {!wide && !narrow ? (
            <button
              type="button"
              className="panel-backdrop"
              aria-label="Close panel"
              tabIndex={-1}
              onClick={() => nav.closePanel()}
            />
          ) : null}
          <PanelHost />
        </>
      ) : null}
    </div>
  )
}

function View() {
  const { route } = useNav()
  if (route.view === 'inbox') {
    return (
      <>
        <ViewHeader title="Inbox" />
        <Inbox />
      </>
    )
  }
  if (route.view === 'journal') {
    return (
      <>
        <ViewHeader title="Journal" />
        <nav className="subnav" aria-label="Journal views">
          {JOURNAL_TABS.map((t) => (
            <a
              key={t.id}
              href={formatHash(toView('journal', t.id))}
              className="subnav-link"
              aria-current={route.tab === t.id ? 'page' : undefined}
            >
              {t.label}
            </a>
          ))}
        </nav>
        {route.tab === 'stream' ? <Stream /> : null}
        {route.tab === 'loops' ? <Loops /> : null}
        {route.tab === 'plans' ? <Plans /> : null}
        {route.tab === 'trackers' ? <Trackers /> : null}
      </>
    )
  }
  return <ViewHeader title="Capture" />
}

function ViewHeader({ title }: { title: string }) {
  const ref = useRef<HTMLHeadingElement>(null)
  const { route } = useNav()
  // Moving to another view puts the reader at its top.
  useEffect(() => {
    if (!route.panel) ref.current?.focus({ preventScroll: true })
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- only when the view itself changes
  }, [route.view])
  return (
    <h1 className="view-title" ref={ref} tabIndex={-1}>
      {title}
    </h1>
  )
}

function Rail({ inert }: { inert: boolean }) {
  const { route } = useNav()
  const count = useInboxCount()
  const sync = useSyncStatus()
  const nav = useNav()
  return (
    <nav className="rail" aria-label="Main" inert={inert}>
      <div className="rail-brand" aria-hidden="true">
        Bullet
      </div>
      <ul className="rail-list">
        {VIEWS.map((v) => (
          <li key={v.view}>
            <a
              href={formatHash(toView(v.view))}
              className="rail-link"
              aria-current={route.view === v.view ? 'page' : undefined}
              aria-label={v.view === 'inbox' ? inboxCornerLabel(count) : undefined}
            >
              <span>{v.label}</span>
              {v.view === 'inbox' && count > 0 ? <span className="badge">{count}</span> : null}
            </a>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className={`sync-status sync-${sync.indicator.kind}`}
        title={sync.indicator.detail}
        aria-label={`Sync status: ${sync.indicator.label}. Open settings`}
        onClick={() => nav.openPanel({ kind: 'settings' })}
      >
        <span className="sync-dot" aria-hidden="true" />
        <span>{sync.indicator.label}</span>
      </button>
    </nav>
  )
}

/** One-time notes about the home server: unreachable (once per outage) or token refused. */
function ServerNotes() {
  const nav = useNav()
  const sync = useSyncStatus()
  if (sync.reachability === 'unauthorized') {
    return (
      <Note
        text={UNAUTHORIZED_TEXT}
        action={
          <Button onClick={() => nav.openPanel({ kind: 'settings' })}>
            Set up the server again
          </Button>
        }
      />
    )
  }
  if (sync.showUnreachableNote) {
    return <Note text={UNREACHABLE_TEXT} onDismiss={sync.dismissUnreachableNote} />
  }
  return null
}

/** Quiet announcements for screen readers ("Added Dentist. Undo is available…"). */
function Announcer(): ReactNode {
  const rt = useRuntime()
  const message = useStore(rt.announcements)
  return (
    <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
      {message}
    </div>
  )
}

function PanelHost() {
  const { route } = useNav()
  const p = route.panel
  if (!p) return null
  switch (p.kind) {
    case 'capture':
      // A new key per capture, so opening another one starts with its own state.
      return <CaptureDetailPanel key={`${p.id}${p.write ? ':w' : ''}`} id={p.id} write={p.write} />
    case 'edit':
      return <EditSuggestionPanel key={p.id} id={p.id} />
    case 'answer':
      return <AnswerPanel key={`${p.target}:${p.id}`} target={p.target} id={p.id} />
    case 'theme':
      return <ThemePanel key={p.id} id={p.id} />
    case 'merge':
      return <MergePanel key={p.id} id={p.id} />
    case 'plan':
      return <PlanEditPanel key={p.id} id={p.id} />
    case 'tracker':
      return <TrackerHistoryPanel key={p.id} id={p.id} />
    case 'activity':
      return <ActivityHistoryPanel key={p.name} name={p.name} />
    case 'pick':
      return <PickQuestionPanel />
    case 'settings':
      return <SettingsPanel />
  }
}
