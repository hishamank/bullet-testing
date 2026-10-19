/**
 * Journal · trackers: each tracker's latest reading and last 14 days, then things done that aren't
 * tracked. Open one for its history. No manual logging: say it in a capture.
 */

import { activityRows, loadTrackers, trackerRows } from '@bullet/client'
import { useLocalQuery, useRuntime } from '../app/hooks'
import { useNav } from '../app/nav'
import { EmptyNote, NavList, SectionTitle } from '../ui/primitives'
import { Sparkline } from '../ui/Sparkline'

export function Trackers() {
  const rt = useRuntime()
  const nav = useNav()
  const tz = rt.deps.timezone()
  const now = Date.now()
  const data = useLocalQuery((db) => loadTrackers(db, Date.now(), tz))
  const rows = trackerRows({ ...data, now, tz })
  const done = activityRows(data.activities, now, tz)
  return (
    <div className="journal-page">
      {rows.length === 0 && done.length === 0 ? <EmptyNote>No trackers yet.</EmptyNote> : null}
      {rows.length > 0 ? (
        <section aria-label="Trackers">
          <NavList className="rows card">
            {rows.map((r) => (
              <li key={r.id} className="row-item">
                <button
                  type="button"
                  className="row-main"
                  data-nav
                  aria-label={`${r.name}, ${r.summary}. ${r.sparkLabel}`}
                  onClick={() => nav.openPanel({ kind: 'tracker', id: r.id })}
                >
                  <span className="row-title">{r.name}</span>
                  <span className={r.hasReadings ? 'caption' : 'caption muted'}>{r.summary}</span>
                </button>
                <Sparkline spark={r.spark} label={r.sparkLabel} />
              </li>
            ))}
          </NavList>
        </section>
      ) : null}
      {done.length > 0 ? (
        <section aria-label="Things you did">
          <SectionTitle>Things you did</SectionTitle>
          <NavList className="rows card">
            {done.map((r) => (
              <li key={r.key} className="row-item">
                <button
                  type="button"
                  className="row-main"
                  data-nav
                  aria-label={`${r.name}, ${r.summary}. ${r.sparkLabel}`}
                  onClick={() => nav.openPanel({ kind: 'activity', name: r.name })}
                >
                  <span className="row-title">{r.name}</span>
                  <span className="caption">{r.summary}</span>
                </button>
                <Sparkline spark={r.spark} label={r.sparkLabel} />
              </li>
            ))}
          </NavList>
        </section>
      ) : null}
      <p className="hint-text">
        To log, just say it in a capture, like “slept 7 hours” or “mood's a 4”. Open a tracker to
        see its history and fix a reading.
      </p>
    </div>
  )
}
