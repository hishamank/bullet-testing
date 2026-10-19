/**
 * Capture detail (a panel): the recording, the home transcript vs the draft, the thoughts (change a
 * kind) with the things they produced, Related, Edit, and the three-choice delete. An answer to a
 * reflective question shows that question above its text; a capture asked about lists the answers.
 * Same content and behaviour as the phone's Capture detail; the logic is all `@bullet/client`.
 */

import {
  AUDIO_READ_ERROR_TEXT,
  audioSource,
  captureStatusLabel,
  clock,
  COPY,
  deleteChoices,
  duration,
  editableText,
  type LinkedThing,
  loadCaptureDetail,
  relatedHeading,
  THING_STATE_LABELS,
  THOUGHT_KINDS,
  thinkingAboutLabel,
  type TranscriptTab,
  transcriptView,
  untranscribableCopy,
  whenLabel,
  writeDownStart,
  type AudioRow,
  type RelatedItem,
} from '@bullet/client'
import { KIND_LABELS } from '@bullet/client/theme'
import { type ThoughtKind } from '@bullet/core'
import { useEffect, useRef, useState } from 'react'
import { isSendShortcut } from '../app/layout'
import { useLocalQuery, useRelated, useRuntime } from '../app/hooks'
import { useActions, useNav } from '../app/nav'
import { toView } from '../app/router'
import { Bidi, Button, NavList, Note, Quoted, SectionTitle } from '../ui/primitives'
import { kindClass } from '../ui/kinds'
import { PanelFrame, PanelGone } from './PanelFrame'

export function CaptureDetailPanel({ id, write }: { id: string; write?: boolean }) {
  const rt = useRuntime()
  const nav = useNav()
  const actions = useActions()
  const tz = rt.deps.timezone()
  const c = useLocalQuery((db) => loadCaptureDetail(db, id, Date.now(), tz), id)
  const related = useRelated(id)
  const [tab, setTab] = useState<TranscriptTab | null>(null)
  const [draft, setDraft] = useState<string | null>(() => (write && c ? writeDownStart(c) : null))
  const [confirming, setConfirming] = useState(false)
  // Undos clicked but not yet reflected (guards a double click). An id leaves once its thing stops
  // being undoable; if the server refuses and it comes back, Undo is offered again.
  const [undoing, setUndoing] = useState<readonly string[]>([])
  const things = c?.things
  useEffect(() => {
    setUndoing((u) => {
      const still = u.filter((x) => things?.some((t) => t.suggestionId === x && t.undoable))
      return still.length === u.length ? u : still
    })
  }, [things])

  if (!c) {
    return (
      <PanelFrame title="Capture">
        <PanelGone>This capture isn't on this device, or it was deleted.</PanelGone>
      </PanelFrame>
    )
  }

  const view = transcriptView(c)
  const shown = tab && view.tabs.some((x) => x.id === tab) ? tab : view.initial
  const editing = draft !== null
  const meta = [
    c.source === 'voice' ? 'Voice note' : 'Typed',
    whenLabel(c.capturedAt, Date.now(), c.timezone),
    c.transcriptionFailure === 'kept' ? 'audio only' : captureStatusLabel(c.status),
  ].join(' · ')
  const canSave = draft !== null && editableText(c.text, draft) !== null

  const save = () => {
    const next = draft === null ? null : editableText(c.text, draft)
    if (next) actions.editCapture(c.id, next)
    setDraft(null)
  }

  const open = (captureId: string) => nav.openPanel({ kind: 'capture', id: captureId })

  const go = (thing: LinkedThing) => {
    const l = thing.link
    if (!l) return
    if (l.to === 'inbox') nav.go(toView('inbox'))
    else if (l.to === 'plans') nav.openPanel({ kind: 'plan', id: l.item })
    else if (l.to === 'trackers') nav.openPanel({ kind: 'tracker', id: l.tracker })
    else nav.openPanel({ kind: 'activity', name: l.name })
  }

  const thingRow = (thing: LinkedThing) => {
    const review = thing.state === 'review'
    const muted = thing.state === 'dismissed' || thing.state === 'removed'
    return (
      <li key={thing.suggestionId} className="thing-line">
        <button
          type="button"
          className="thing"
          disabled={!thing.link}
          data-nav
          aria-label={`${thing.label}, ${THING_STATE_LABELS[thing.state]}`}
          onClick={() => go(thing)}
        >
          <span className={`thing-label${muted ? ' struck muted' : ''}`}>{thing.label}</span>
          <span className={review ? 'caption accent' : 'caption'}>
            {THING_STATE_LABELS[thing.state]}
          </span>
        </button>
        {thing.undoable ? (
          <Button
            aria-label={`Undo: ${thing.label}`}
            disabled={undoing.includes(thing.suggestionId)}
            onClick={() => {
              if (undoing.includes(thing.suggestionId)) return
              setUndoing((u) => [...u, thing.suggestionId])
              rt.inbox.undoApplied(thing.suggestionId, thing.label)
            }}
          >
            Undo
          </Button>
        ) : null}
      </li>
    )
  }

  const loose = c.things.filter(
    (x) => !x.thoughtId || !c.thoughts.some((th) => th.id === x.thoughtId),
  )
  const [cascade, keep] = deleteChoices(c.things.length)

  return (
    <PanelFrame
      title="Capture"
      actions={
        editing ? (
          <>
            <Button variant="quiet" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!canSave} onClick={save}>
              Save
            </Button>
          </>
        ) : (
          <Button aria-label="Edit text" onClick={() => setDraft(c.text)}>
            Edit
          </Button>
        )
      }
    >
      <p className="caption">{meta}</p>
      {c.notices.map((n) => (
        <Note key={n.key} text={n.text} onDismiss={() => rt.inbox.dismissNotice(n.key)} />
      ))}
      {c.errorReason ? (
        <div className="row">
          <p className="warn grow">Not processed. {c.errorReason} Your capture is safe.</p>
          <Button onClick={() => actions.retryCaptures([c.id])}>Retry</Button>
        </div>
      ) : null}
      {c.transcriptionFailure === 'ask' && !editing ? (
        <div className="stack-sm">
          <p className="warn strong">{untranscribableCopy(c.errorCode).title}</p>
          <p className="caption">{untranscribableCopy(c.errorCode).detail}</p>
          <div className="row">
            <Button onClick={() => setDraft(writeDownStart(c))}>Write it down</Button>
            <Button variant="quiet" onClick={() => actions.keepAsAudio(c.id)}>
              Keep as audio
            </Button>
          </div>
        </div>
      ) : null}
      {c.retryTranscription && !editing ? (
        <div className="row">
          <p className="caption grow">
            The home server found no speech it could use, so the phone's live draft was read.
          </p>
          <Button onClick={() => actions.retryCaptures([c.id])}>Retry transcription</Button>
        </div>
      ) : null}
      {c.audioReadError ? <p className="caption">{AUDIO_READ_ERROR_TEXT}</p> : null}

      {c.thinkingAbout ? (
        <div className="about kind-question">
          <span className="caption">Thinking about</span>
          <Bidi as="p" text={c.thinkingAbout.text} className="question-text" />
          {c.thinkingAbout.sourceLine ? (
            c.thinkingAbout.sourceBulletId ? (
              <button
                type="button"
                className="link"
                aria-label={[thinkingAboutLabel(c.thinkingAbout.text), c.thinkingAbout.sourceLine]
                  .filter(Boolean)
                  .join('. ')}
                onClick={() => open(c.thinkingAbout?.sourceBulletId ?? '')}
              >
                {c.thinkingAbout.sourceLine} ›
              </button>
            ) : (
              <span className="caption">{c.thinkingAbout.sourceLine}</span>
            )
          ) : null}
          {c.thinkingAbout.canAddMore ? (
            <Button
              aria-label={`Add more: ${c.thinkingAbout.text}`}
              onClick={() =>
                nav.openPanel({
                  kind: 'answer',
                  target: 'question',
                  id: c.thinkingAbout?.questionId ?? '',
                })
              }
            >
              Add more
            </Button>
          ) : null}
        </div>
      ) : null}

      {c.audio ? <AudioPlayer audio={c.audio} /> : null}

      {editing ? (
        <>
          <label className="visually-hidden" htmlFor="capture-text-edit">
            Capture text
          </label>
          <textarea
            id="capture-text-edit"
            className="editor"
            rows={8}
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- the user just chose Edit
            autoFocus
            value={draft ?? ''}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (isSendShortcut(e) && canSave) {
                e.preventDefault()
                save()
              }
            }}
          />
          <p className="caption">
            Saving reads it again: thoughts and things are updated to match.
          </p>
        </>
      ) : (
        <>
          {view.tabs.length > 0 ? (
            <div role="tablist" aria-label="Which text" className="tabs">
              {view.tabs.map((x) => (
                <button
                  key={x.id}
                  type="button"
                  role="tab"
                  aria-selected={x.id === shown}
                  className="tab"
                  onClick={() => setTab(x.id)}
                >
                  {x.label}
                </button>
              ))}
            </div>
          ) : null}
          <Bidi
            as="p"
            text={view.text(shown)}
            className={`capture-text${shown === 'draft' ? ' secondary' : ''}`}
          />
          {view.note ? <p className="caption">{view.note}</p> : null}
        </>
      )}

      {c.thoughts.length > 0 ? (
        <section aria-label="Thoughts">
          <SectionTitle level={3} count={c.thoughts.length}>
            Thoughts
          </SectionTitle>
          <ul className="rows card">
            {c.thoughts.map((th) => {
              const mine = c.things.filter((x) => x.thoughtId === th.id)
              return (
                <li key={th.id} className="thought-block">
                  <div className="thought-line">
                    <KindPicker
                      thoughtText={th.text}
                      kind={th.kind}
                      onPick={(kind) => actions.changeKind(th.id, kind)}
                    />
                    <Bidi text={th.text} className="thought-text" />
                  </div>
                  {mine.length > 0 ? (
                    <NavList className="things">{mine.map(thingRow)}</NavList>
                  ) : null}
                </li>
              )
            })}
          </ul>
          <p className="caption">Your choice of kind sticks, even if the capture is read again.</p>
        </section>
      ) : null}

      <RelatedList
        items={related}
        onOpen={open}
        onNotRelated={(linkId) => actions.notRelated(linkId)}
      />

      {c.thoughtAbout.length > 0 ? (
        <section aria-label="You thought about this">
          <SectionTitle level={3} count={c.thoughtAbout.length}>
            You thought about this
          </SectionTitle>
          <NavList className="rows card">
            {c.thoughtAbout.map((a) => (
              <li key={a.id} className="row-item">
                <button
                  type="button"
                  className="row-main"
                  data-nav
                  aria-label={`${a.source === 'voice' ? 'Voice answer' : 'Answer'}, ${clock(a.capturedAt, a.timezone)}: ${a.snippet}`}
                  onClick={() => open(a.id)}
                >
                  <Bidi text={a.snippet} className="row-title" />
                  <span className="caption">{whenLabel(a.capturedAt, Date.now(), a.timezone)}</span>
                </button>
                <span className="caption accent">Open</span>
              </li>
            ))}
          </NavList>
        </section>
      ) : null}

      {loose.length > 0 ? (
        <section aria-label="Things">
          <SectionTitle level={3}>Things</SectionTitle>
          <NavList className="things">{loose.map(thingRow)}</NavList>
        </section>
      ) : null}

      <div className="danger-zone">
        {confirming ? (
          <div role="alertdialog" aria-labelledby="delete-title" className="confirm">
            <h3 id="delete-title">Delete this capture?</h3>
            <p>{cascade?.detail}</p>
            <p className="caption">Or keep what it made: {keep?.detail.toLowerCase()}</p>
            <div className="row">
              <Button
                // oxlint-disable-next-line jsx-a11y/no-autofocus -- the safe choice gets focus
                autoFocus
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
              {[cascade, keep].map((choice) =>
                choice ? (
                  <Button
                    key={choice.mode}
                    variant="danger"
                    onClick={() => {
                      actions.deleteCapture(c.id, choice.mode)
                      nav.closePanel()
                    }}
                  >
                    {choice.title}
                  </Button>
                ) : null,
              )}
            </div>
          </div>
        ) : (
          <Button variant="danger" onClick={() => setConfirming(true)}>
            Delete capture…
          </Button>
        )}
      </div>
    </PanelFrame>
  )
}

/** A thought's kind as a pill you can change: a real select, so the keyboard works as usual. */
function KindPicker({
  thoughtText,
  kind,
  onPick,
}: {
  thoughtText: string
  kind: ThoughtKind
  onPick: (kind: ThoughtKind) => void
}) {
  return (
    <span className="kind-picker">
      <select
        className={`kind-select pill ${kindClass(kind)}`}
        aria-label={`Kind of: ${thoughtText}`}
        value={kind}
        onChange={(e) => onPick(e.target.value as ThoughtKind)}
      >
        {THOUGHT_KINDS.map((k) => (
          <option key={k} value={k}>
            {KIND_LABELS[k]}
          </option>
        ))}
      </select>
    </span>
  )
}

/** Related · N: a date and the quoted thought; "Not related" removes the link for good. */
function RelatedList({
  items,
  onOpen,
  onNotRelated,
}: {
  items: readonly RelatedItem[]
  onOpen: (bulletId: string) => void
  onNotRelated: (linkId: string) => void
}) {
  if (items.length === 0) return null
  return (
    <section aria-label={COPY.relatedTitle}>
      <SectionTitle level={3}>{relatedHeading(items.length)}</SectionTitle>
      <NavList className="rows card">
        {items.map((r) => (
          <li key={r.linkId} className="row-item">
            <button
              type="button"
              className="row-main"
              data-nav
              aria-label={r.label}
              onClick={() => onOpen(r.bulletId)}
            >
              <span className="caption">{r.meta}</span>
              <Quoted text={r.text} rtl={r.rtl} />
            </button>
            <Button
              aria-label={`${COPY.notRelated}: ${r.label}`}
              onClick={() => onNotRelated(r.linkId)}
            >
              {COPY.notRelated}
            </Button>
          </li>
        ))}
      </NavList>
      <p className="caption">{COPY.notRelatedNote}</p>
    </section>
  )
}

/**
 * The recording. The home server serves audio behind the device token, which an `<audio>` element
 * can't send, so Play fetches it (the token in the header) and plays the blob.
 */
function AudioPlayer({ audio }: { audio: AudioRow }) {
  const rt = useRuntime()
  const source = audioSource(audio, { localExists: () => false, server: rt.server() })
  const [url, setUrl] = useState<string | null>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle')
  const player = useRef<HTMLAudioElement>(null)
  useEffect(() => () => (url ? URL.revokeObjectURL(url) : undefined), [url])
  useEffect(() => {
    if (url) void player.current?.play().catch(() => {})
  }, [url])

  if (source.kind === 'unavailable') {
    return (
      <div className="card audio">
        <p className="caption">{source.reason}</p>
      </div>
    )
  }
  const length = duration(audio.duration_ms)
  if (url) {
    return (
      <div className="card audio">
        {/* A voice note has no captions: its transcript is the text below. */}
        {/* oxlint-disable-next-line jsx-a11y/media-has-caption */}
        <audio ref={player} controls src={url} aria-label={`Voice note, ${length}`} />
      </div>
    )
  }
  return (
    <div className="card audio row">
      <Button
        variant="primary"
        disabled={state === 'loading'}
        onClick={() => {
          setState('loading')
          rt.fetch(source.uri, { headers: source.kind === 'remote' ? source.headers : undefined })
            .then((res) => {
              if (!res.ok) throw new Error(String(res.status))
              return res.blob()
            })
            .then((blob) => setUrl(URL.createObjectURL(blob)))
            .catch(() => setState('error'))
        }}
      >
        {state === 'loading' ? 'Loading…' : '▶ Play recording'}
      </Button>
      <span className="caption">Voice note · {length}</span>
      {state === 'error' ? (
        <span className="warn">The recording couldn't be loaded. Try again in a moment.</span>
      ) : null}
    </div>
  )
}
