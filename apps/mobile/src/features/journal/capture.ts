/**
 * Capture detail: the capture, its recording, both transcripts, its thoughts and the things they
 * produced. `loadCaptureDetail` is the query; transcript tabs, the audio source and the delete
 * choices are pure.
 */

import {
  type BulletDeleteMode,
  type BulletProcessingStatus,
  displayStatus,
  type TargetKind,
  type ThoughtKind,
  thoughtKindSchema,
} from '@bullet/core'
import { and, eq } from 'drizzle-orm'
import type { PhoneDb } from '../../data/db'
import { ENTITY_TABLES, bulletsWithPendingChanges } from '../../data/mirror'
import { listRejections } from '../../data/rejections'
import {
  audioAttachments,
  bullets,
  suggestions,
  thoughts,
  trackers,
  transcripts,
} from '../../data/schema'
import { type InboxNotice, noticeText, summaryContext } from '../inbox/model'
import { keptAsAudio } from './audio-only'
import {
  errorReason,
  type TranscriptionFailure,
  transcriptionFailure,
  unreadableRecordings,
} from './stream'
import { type LinkedThing, linkedThing, type SuggestionRow } from './things'

export interface TranscriptRow {
  kind: 'device_draft' | 'server'
  text: string
}

export interface AudioRow {
  id: string
  duration_ms: number
  local_path: string | null
  upload_status: 'pending' | 'uploaded'
  mime_type: string
}

export interface CaptureDetail {
  id: string
  text: string
  source: 'text' | 'voice'
  capturedAt: number
  timezone: string
  textEditedByUser: boolean
  status: BulletProcessingStatus
  /** A retryable failure's reason (null for a recording that can't be transcribed). */
  errorReason: string | null
  /** The recording can't be transcribed: `ask` (Write it down / Keep as audio) or `kept`. */
  transcriptionFailure: TranscriptionFailure
  audio: AudioRow | null
  /** This phone couldn't read the recording file to upload it (the text is kept). */
  audioReadError: boolean
  transcripts: TranscriptRow[]
  thoughts: { id: string; kind: ThoughtKind; kindSource: 'engine' | 'user'; text: string }[]
  things: LinkedThing[]
  /** Calm notes for an Undo of one of its things the server refused (e.g. edited since). */
  notices: InboxNotice[]
}

export function loadCaptureDetail(
  db: PhoneDb,
  id: string,
  now: number,
  tz: string,
): CaptureDetail | null {
  const b = db
    .select()
    .from(bullets)
    .where(and(eq(bullets.id, id), eq(bullets.state, 'active')))
    .get()
  if (!b) return null
  const status = displayStatus(b.server_status, bulletsWithPendingChanges(db).has(id))
  const audio =
    db
      .select()
      .from(audioAttachments)
      .where(and(eq(audioAttachments.bullet_id, id), eq(audioAttachments.state, 'active')))
      .get() ?? null
  const ts = db
    .select({ kind: transcripts.kind, text: transcripts.text })
    .from(transcripts)
    .where(and(eq(transcripts.bullet_id, id), eq(transcripts.state, 'active')))
    .orderBy(transcripts.transcribed_at)
    .all()
  const th = db
    .select()
    .from(thoughts)
    .where(and(eq(thoughts.source_bullet_id, id), eq(thoughts.state, 'active')))
    .orderBy(thoughts.position)
    .all()
  const ss = db
    .select()
    .from(suggestions)
    .where(and(eq(suggestions.source_bullet_id, id), eq(suggestions.state, 'active')))
    .orderBy(suggestions.created_at)
    .all()
  const look = {
    entity: (kind: TargetKind, entityId: string) => {
      const table = ENTITY_TABLES[kind as keyof typeof ENTITY_TABLES] as unknown as
        | typeof bullets
        | undefined
      if (!table) return null
      return (db.select().from(table).where(eq(table.id, entityId)).get() ?? null) as Record<
        string,
        unknown
      > | null
    },
    tracker: (trackerId: string) =>
      db
        .select({ name: trackers.name, config: trackers.config })
        .from(trackers)
        .where(eq(trackers.id, trackerId))
        .get() ?? null,
  }
  const failure = transcriptionFailure(
    status,
    b.server_error_code,
    keptAsAudio(db, [b.id]).has(b.id),
  )
  return {
    id: b.id,
    text: b.text,
    source: b.source,
    capturedAt: b.captured_at,
    timezone: b.timezone,
    textEditedByUser: b.text_edited_by_user,
    status,
    errorReason: status === 'failed' && failure === null ? errorReason(b.server_error_code) : null,
    transcriptionFailure: failure,
    audio,
    audioReadError: audio ? unreadableRecordings(db, [audio.id]).has(audio.id) : false,
    transcripts: ts,
    thoughts: th.map((t) => ({ id: t.id, kind: t.kind, kindSource: t.kind_source, text: t.text })),
    things: ss.map((s) => linkedThing(s as SuggestionRow, look, now, tz)),
    notices: undoNotices(db, ss, now, tz),
  }
}

/** Refused Undos of this capture's things, worded like the Inbox's notices. */
function undoNotices(
  db: PhoneDb,
  rows: (typeof suggestions.$inferSelect)[],
  now: number,
  tz: string,
): InboxNotice[] {
  const named = new Map(rows.map((s) => [s.id, s]))
  const refused = listRejections(db).filter(
    (r) => r.type === 'suggestion.undo' && r.suggestion_id !== null && named.has(r.suggestion_id),
  )
  if (refused.length === 0) return []
  const ctx = summaryContext(db, rows, now, tz)
  return refused.flatMap((r) => {
    const text = noticeText(r, named, ctx)
    return text ? [{ key: r.key, text }] : []
  })
}

// ---- pure ----

export type TranscriptTab = 'edit' | 'server' | 'draft'

export interface TranscriptView {
  /** Tabs to show; empty when there is nothing to switch between. */
  tabs: { id: TranscriptTab; label: string }[]
  initial: TranscriptTab
  text: (tab: TranscriptTab) => string
  /** A quiet line under the text. */
  note: string | null
}

function lastOf(ts: readonly TranscriptRow[], kind: TranscriptRow['kind']): TranscriptRow | null {
  let found: TranscriptRow | null = null
  for (const t of ts) if (t.kind === kind) found = t
  return found
}

/**
 * Home transcript vs phone draft. A typed capture has neither: its text is shown as is. When the
 * user edited a voice note's text, their edit is the capture and comes first; both transcripts
 * stay viewable.
 */
export function transcriptView(
  c: Pick<CaptureDetail, 'text' | 'source' | 'textEditedByUser' | 'transcripts'>,
): TranscriptView {
  const server = lastOf(c.transcripts, 'server')
  const draft = lastOf(c.transcripts, 'device_draft')
  const edited = c.source === 'voice' && c.textEditedByUser
  const tabs: TranscriptView['tabs'] = []
  if (edited) tabs.push({ id: 'edit', label: 'Your text' })
  if (server) tabs.push({ id: 'server', label: 'Home transcript' })
  if (draft) tabs.push({ id: 'draft', label: 'Phone draft' })
  let note: string | null = null
  if (edited) note = 'You edited the text, so your words are kept.'
  else if (c.source === 'voice' && !server) {
    note = 'Live draft. Your recording is kept and transcribed again at home.'
  }
  return {
    tabs: tabs.length > 1 ? tabs : [],
    initial: tabs[0]?.id ?? 'edit',
    text: (tab) => {
      if (tab === 'server' && server) return server.text
      if (tab === 'draft' && draft) return draft.text
      return c.text
    },
    note,
  }
}

export type AudioSourceResult =
  | { kind: 'local'; uri: string }
  | { kind: 'remote'; uri: string; headers: Record<string, string> }
  | { kind: 'unavailable'; reason: string }

/** Play the file on this phone first; else stream it from the home server once it's there. */
export function audioSource(
  audio: Pick<AudioRow, 'id' | 'local_path' | 'upload_status'>,
  opts: {
    localExists: (path: string) => boolean
    server: { baseUrl: string; token: string } | null
    /**
     * `local_path` is stored relative to Documents (`recordings/<id>.wav`): turn it into today's
     * file uri (`recordingUri` in sync/runtime.ts). Defaults to using it as is.
     */
    resolveLocal?: (path: string) => string
  },
): AudioSourceResult {
  const local = audio.local_path ? (opts.resolveLocal ?? ((p) => p))(audio.local_path) : null
  if (local && opts.localExists(local)) {
    return { kind: 'local', uri: local }
  }
  if (audio.upload_status !== 'uploaded') {
    return {
      kind: 'unavailable',
      reason: 'The recording is still on the phone that made it. It plays here once it has synced.',
    }
  }
  if (!opts.server) {
    return { kind: 'unavailable', reason: 'Connect to your home server to play this recording.' }
  }
  return {
    kind: 'remote',
    uri: `${opts.server.baseUrl.replace(/\/+$/, '')}/sync/audio/${encodeURIComponent(audio.id)}`,
    headers: { authorization: `Bearer ${opts.server.token}` },
  }
}

export const THOUGHT_KINDS: readonly ThoughtKind[] = thoughtKindSchema.options

export interface DeleteChoice {
  mode: BulletDeleteMode
  title: string
  detail: string
}

/** The three-choice dialog's two delete options (Cancel is the third). */
export function deleteChoices(thingCount: number): DeleteChoice[] {
  return [
    {
      mode: 'cascade',
      title: 'Delete + extractions',
      detail:
        thingCount > 0
          ? 'The capture and everything it produced go away.'
          : 'The capture and its thoughts go away.',
    },
    {
      mode: 'keep_extractions',
      title: 'Delete but keep extractions',
      detail: 'Only the capture goes. Tasks, events and readings it made stay.',
    },
  ]
}

/**
 * Where "Write it down" starts: the phone's live draft if there was one, else the capture text,
 * unless that is only the "Voice note, 0:12" placeholder.
 */
export function writeDownStart(c: Pick<CaptureDetail, 'text' | 'transcripts'>): string {
  const draft = lastOf(c.transcripts, 'device_draft')?.text.trim()
  if (draft) return draft
  return /^Voice note, [\d:]+$/.test(c.text.trim()) ? '' : c.text
}

/** An edit is saved only when it is non-empty and actually changes the text. */
export function editableText(original: string, draft: string): string | null {
  const next = draft.trim()
  return next === '' || next === original.trim() ? null : next
}
