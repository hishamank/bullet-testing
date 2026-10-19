/** One capture's waiting suggestions: its snippet, a row per suggestion, and "Accept both". */

import { type CaptureGroup, type DecideItem, logsLine, trackerNameOrNull } from '@bullet/client'
import type { BulletSource } from '@bullet/core'
import { useState } from 'react'
import { useNav } from '../app/nav'
import { useRuntime } from '../app/hooks'
import { Bidi, Button, KindPill, NavList } from '../ui/primitives'

/** The capture a row came from: its quoted snippet, opening Capture detail. */
export function CaptureLink({
  bulletId,
  snippet,
  source,
}: {
  bulletId: string
  snippet: string
  source: BulletSource
}) {
  const nav = useNav()
  if (!snippet) return null
  const voice = source === 'voice'
  return (
    <button
      type="button"
      className="source-link"
      data-nav
      aria-label={`${voice ? 'Voice capture' : 'Capture'} ${snippet}`}
      onClick={() => nav.openPanel({ kind: 'capture', id: bulletId })}
    >
      <span aria-hidden="true">{voice ? '▶' : '¶'}</span>
      <Bidi text={snippet} className="clamp" />
    </button>
  )
}

/** Tiers shown as behaviour, never as numbers. */
function tierHint(item: DecideItem): string | null {
  if (item.isNewTracker) return null // the group's note says it
  return item.tier === 'ask' ? 'Not sure about this one: have a look.' : null
}

export function DecideGroup({ group }: { group: CaptureGroup }) {
  const rt = useRuntime()
  const all = group.pending.length === 2 ? 'Accept both' : 'Accept all'
  return (
    <article className="card decide-group">
      <CaptureLink bulletId={group.bulletId} snippet={group.snippet} source={group.source} />
      <NavList className="decide-rows">
        {group.items.map((item) => (
          <SuggestionRow key={item.id} item={item} />
        ))}
      </NavList>
      {group.pending.length >= 2 ? (
        <div className="row end">
          <Button
            aria-label={`${all}: ${group.pending.map((i) => i.summary.spoken).join('; ')}`}
            onClick={() => rt.inbox.acceptAll(group.pending.map((i) => i.id))}
          >
            {all}
          </Button>
        </div>
      ) : null}
      {group.hasNewTracker ? (
        <p className="caption">New trackers always wait for your OK.</p>
      ) : null}
    </article>
  )
}

/**
 * A new tracker: "Start tracking Mood?" with its name pre-filled and editable, and the reading it
 * logs. "Start tracking" accepts it (with the edited name); "Not now" dismisses it.
 */
function NewTrackerRow({ item }: { item: DecideItem }) {
  const rt = useRuntime()
  const [name, setName] = useState(item.trackerName ?? '')
  const clean = trackerNameOrNull(name)
  const shown = clean ?? item.trackerName ?? item.summary.name
  const logs = logsLine(item.logs)
  return (
    <li className="decide-row tracker-row">
      <KindPill kind={item.summary.pill.kind} label={item.summary.pill.label} />
      <p className="strong">Start tracking {shown}?</p>
      <label className="field">
        <span className="visually-hidden">Tracker name</span>
        <input
          type="text"
          value={name}
          placeholder={item.trackerName ?? 'Name'}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && clean) rt.inbox.startTracking(item.id, clean)
          }}
        />
      </label>
      {logs ? <p className="caption">{logs}</p> : null}
      <div className="row end">
        <Button
          variant="quiet"
          data-nav
          aria-label={`Not now: don't track ${shown}`}
          onClick={() => rt.inbox.dismiss(item.id, item.summary.spoken)}
        >
          Not now
        </Button>
        <Button
          data-nav
          aria-label={`Start tracking ${shown}`}
          disabled={clean === null}
          onClick={() => clean && rt.inbox.startTracking(item.id, clean)}
        >
          Start tracking
        </Button>
      </div>
    </li>
  )
}

function SuggestionRow({ item }: { item: DecideItem }) {
  const rt = useRuntime()
  const nav = useNav()
  const { summary } = item
  const hint = tierHint(item)

  if (item.isNewTracker && !item.decision) return <NewTrackerRow item={item} />

  if (item.decision) {
    const word = item.decision === 'accepted' ? 'Added' : 'Dismissed'
    return (
      <li className="decide-row decided" aria-live="polite">
        <div className="decide-text">
          <KindPill kind={summary.pill.kind} label={summary.pill.label} />
          <span className="muted">{summary.text}</span>
        </div>
        <div className="row">
          <span className="caption">{word}</span>
          <Button
            data-nav
            aria-label={`Undo ${item.decision === 'accepted' ? 'adding' : 'dismissing'} ${summary.spoken}`}
            onClick={() => rt.inbox.undoDecision(item.id)}
          >
            Undo
          </Button>
        </div>
      </li>
    )
  }

  return (
    <li className="decide-row">
      <div className="decide-text">
        <div className="row">
          <KindPill kind={summary.pill.kind} label={summary.pill.label} />
        </div>
        <p>{summary.ask}</p>
        {hint ? <p className="caption">{hint}</p> : null}
      </div>
      <div className="row">
        {item.editable ? (
          <Button
            data-nav
            aria-label={`Edit before adding: ${summary.spoken}`}
            onClick={() => nav.openPanel({ kind: 'edit', id: item.id })}
          >
            Edit
          </Button>
        ) : null}
        <Button
          variant="quiet"
          data-nav
          aria-label={`Dismiss ${summary.spoken}`}
          onClick={() => rt.inbox.dismiss(item.id, summary.spoken)}
        >
          Dismiss
        </Button>
        <Button
          variant="option"
          data-nav
          aria-label={`Accept ${summary.spoken}`}
          onClick={() => rt.inbox.accept(item.id, summary.spoken)}
        >
          Accept
        </Button>
      </div>
    </li>
  )
}
