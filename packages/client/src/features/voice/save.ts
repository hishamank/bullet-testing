/**
 * Saving a voice note, and recovering one a crash interrupted. File access, the database and the
 * clock are injected: this runs in Vitest against an in-memory file system.
 *
 * On disk (under the app's documents, never the cache):
 *
 *   recordings/session-<id>/meta.json     what to save it as (links, draft so far)
 *   recordings/session-<id>/seg-001.wav   one file per stretch of recording
 *   recordings/<id>.wav                   the joined recording a bullet points at (kept forever;
 *                                         `local_path` stores it relative to Documents)
 *
 * The session folder is removed only after the bullet that owns the joined file is saved, so a
 * kill at any point leaves something `recoverRecordings` can still save.
 */

import { eq, like, or } from 'drizzle-orm'
import type { PhoneDb } from '../../data/db'
import {
  type CaptureLinks,
  captureVoiceBullet,
  type LocalDeps,
  type VoiceCaptureInput,
} from '../../data/local'
import { audioAttachments } from '../../data/schema'
import { RECORDINGS_DIR, storedRecordingPath } from '../../sync/audio-path'
import { assembleSegments, hashFile, type VoiceFileIo } from './assemble'
import { formatTimer } from './format'
import type { FinishedRecording } from './session'

/** Name of the on-device recognizer, stored with the draft transcript. */
export const DRAFT_ENGINE = 'apple-sfspeechrecognizer'
export const DRAFT_LANGUAGE = 'en-US'

export interface SessionMeta {
  id: string
  startedAt: number
  links: CaptureLinks
  /** The live draft so far (updated as stretches finish). */
  draft: string
  liveDraft: boolean
}

export interface VoiceStoreIo extends VoiceFileIo {
  exists: (uri: string) => boolean
  /** Names (not uris) of the entries in a directory; [] when it doesn't exist. */
  list: (dir: string) => string[]
  readText: (uri: string) => string | null
  writeText: (uri: string, text: string) => void
  ensureDir: (dir: string) => void
  /** Delete a file or a whole directory; no-op when missing. */
  remove: (uri: string) => void
  move: (from: string, to: string) => void
}

export interface VoiceStoreDeps {
  db: PhoneDb
  local: LocalDeps
  io: VoiceStoreIo
  /** The recordings directory's uri today, ending in '/' (`<Documents>/recordings/`). */
  root: string
}

const SESSION_PREFIX = 'session-'

export const sessionDir = (root: string, id: string) => `${root}${SESSION_PREFIX}${id}/`
export const segmentName = (n: number) => `seg-${String(n).padStart(3, '0')}.wav`
const metaUri = (dir: string) => `${dir}meta.json`

export function writeSessionMeta(deps: VoiceStoreDeps, meta: SessionMeta): void {
  const dir = sessionDir(deps.root, meta.id)
  deps.io.ensureDir(dir)
  deps.io.writeText(metaUri(dir), JSON.stringify(meta))
}

/** What the bullet says before the server's transcript arrives. Never empty. */
export function voiceNoteText(draft: string, durationMs: number): string {
  const text = draft.trim()
  return text !== '' ? text : `Voice note, ${formatTimer(durationMs)}`
}

export function voiceCaptureInput(args: {
  draft: string
  liveDraft: boolean
  links: CaptureLinks
  audio: VoiceCaptureInput['audio']
}): VoiceCaptureInput {
  const draft = args.draft.trim()
  return {
    ...args.links,
    text: voiceNoteText(draft, args.audio.durationMs),
    // The draft (or placeholder) is not the user's words: the server transcript replaces it.
    textEditedByUser: false,
    audio: args.audio,
    draft: {
      text: draft,
      engine: DRAFT_ENGINE,
      model: null,
      languages: args.liveDraft && draft !== '' ? [DRAFT_LANGUAGE] : [],
    },
  }
}

function extensionOf(mimeType: string): string {
  return mimeType === 'audio/mp4' ? 'm4a' : 'audio'
}

/**
 * A compressed (m4a) recording can't be joined here. Normally there is one file; if the recorder
 * had to start over (media services reset), each file is saved as its own voice note rather than
 * dropped. The first one carries the links and the draft.
 */
async function saveSingleFiles(
  deps: VoiceStoreDeps,
  sessionId: string,
  rec: FinishedRecording,
  links: CaptureLinks,
  local: LocalDeps,
): Promise<string | null> {
  const { io, root } = deps
  const ids: string[] = []
  for (const [i, file] of rec.files.entries()) {
    if (!io.exists(file) || io.size(file) === 0) continue
    const name = `${sessionId}${i === 0 ? '' : `-${i + 1}`}.${extensionOf(rec.mimeType)}`
    const out = `${root}${name}`
    if (file !== out) io.move(file, out)
    const sizeBytes = io.size(out)
    const first = ids.length === 0
    const audio: VoiceCaptureInput['audio'] = {
      localPath: storedRecordingPath(name),
      mimeType: rec.mimeType,
      // Only the whole recording's length is known; a lone file gets it exactly.
      durationMs: rec.files.length === 1 ? Math.round(rec.recordedMs) : 0,
      sizeBytes,
      sha256: await hashFile(io, out),
    }
    ids.push(
      captureVoiceBullet(
        deps.db,
        voiceCaptureInput({
          draft: first ? rec.draft : '',
          liveDraft: rec.liveDraft,
          links: first ? links : {},
          audio,
        }),
        local,
      ),
    )
  }
  io.remove(sessionDir(root, sessionId))
  return ids[0] ?? null
}

/** Saved already: stored relative today, or (rows from before) as an absolute path. */
function alreadySaved(db: PhoneDb, fileName: string): boolean {
  return (
    db
      .select({ id: audioAttachments.id })
      .from(audioAttachments)
      .where(
        or(
          eq(audioAttachments.local_path, storedRecordingPath(fileName)),
          like(audioAttachments.local_path, `%/${RECORDINGS_DIR}${fileName}`),
        ),
      )
      .get() !== undefined
  )
}

/**
 * Turn a finished recording into a saved voice capture: join its files into the kept recording,
 * then create the bullet, its attachment, the draft transcript and the outbox op. Returns the
 * bullet id, or null when nothing was recorded.
 */
export async function saveVoiceNote(
  deps: VoiceStoreDeps,
  sessionId: string,
  rec: FinishedRecording,
  links: CaptureLinks,
  local: LocalDeps = deps.local,
): Promise<string | null> {
  const { io, root } = deps
  if (rec.mimeType !== 'audio/wav') return saveSingleFiles(deps, sessionId, rec, links, local)
  const name = `${sessionId}.wav`
  const out = `${root}${name}`
  const plan = await assembleSegments(rec.files, out, io)
  if (!plan) return null
  const audio: VoiceCaptureInput['audio'] = {
    localPath: storedRecordingPath(name),
    mimeType: 'audio/wav',
    durationMs: plan.durationMs,
    sizeBytes: plan.sizeBytes,
    sha256: plan.sha256,
  }
  const id = captureVoiceBullet(
    deps.db,
    voiceCaptureInput({ draft: rec.draft, liveDraft: rec.liveDraft, links, audio }),
    local,
  )
  io.remove(sessionDir(root, sessionId))
  return id
}

/** Throw away a cancelled recording's files. */
export function discardSession(deps: VoiceStoreDeps, sessionId: string, files: string[]): void {
  for (const f of files) deps.io.remove(f)
  deps.io.remove(sessionDir(deps.root, sessionId))
}

/**
 * Save every recording a crash or a kill left behind (only `segments` recordings: their WAV files
 * stay readable after a kill). Skips the sessions in `skip` (recording or being saved right now).
 * Returns the ids of the bullets created.
 */
export async function recoverRecordings(
  deps: VoiceStoreDeps,
  skip: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const { io, root } = deps
  const saved: string[] = []
  for (const name of io.list(root)) {
    if (!name.startsWith(SESSION_PREFIX)) continue
    const id = name.slice(SESSION_PREFIX.length)
    if (skip.has(id)) continue
    const dir = sessionDir(root, id)
    // Saved, then killed before the folder was removed: just tidy up.
    if (alreadySaved(deps.db, `${id}.wav`)) {
      io.remove(dir)
      continue
    }
    const meta = parseMeta(io.readText(metaUri(dir)))
    const files = io
      .list(dir)
      .filter((n) => /^seg-\d+\.wav$/.test(n))
      .sort()
      .map((n) => `${dir}${n}`)
    const startedAt = meta?.startedAt ?? deps.local.now()
    const bulletId = await saveVoiceNote(
      deps,
      id,
      {
        files,
        mimeType: 'audio/wav',
        draft: meta?.draft ?? '',
        liveDraft: meta?.liveDraft ?? false,
        recordedMs: 0,
      },
      meta?.links ?? {},
      { ...deps.local, now: () => startedAt },
    )
    if (bulletId) saved.push(bulletId)
    else io.remove(dir)
  }
  return saved
}

/**
 * Crash recovery, one run at a time: a call while a run is going joins it instead of saving the
 * same leftovers twice. `live` is read as each folder is reached, so a recording that starts
 * mid-run is skipped.
 */
export function createRecovery(
  deps: () => VoiceStoreDeps,
  live: ReadonlySet<string>,
): () => Promise<string[]> {
  let running: Promise<string[]> | null = null
  return () => {
    running ??= recoverRecordings(deps(), live).finally(() => {
      running = null
    })
    return running
  }
}

function parseMeta(text: string | null): SessionMeta | null {
  if (!text) return null
  try {
    const m = JSON.parse(text) as Partial<SessionMeta>
    return typeof m.id === 'string' && typeof m.startedAt === 'number'
      ? {
          id: m.id,
          startedAt: m.startedAt,
          links: m.links ?? {},
          draft: typeof m.draft === 'string' ? m.draft : '',
          liveDraft: m.liveDraft === true,
        }
      : null
  } catch {
    return null
  }
}
