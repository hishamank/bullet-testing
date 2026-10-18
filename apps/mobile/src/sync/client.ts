/**
 * The sync client: drain the outbox (oldest first, in batches), upload voice recordings the
 * server doesn't fully have (resuming where they stopped), then pull until caught up.
 *
 *  - Single-flight: overlapping requests coalesce; one more run follows if asked mid-run.
 *  - Idempotent retries: an op leaves the outbox only once the server answered it, and the
 *    server de-duplicates by op_id, so resending after any failure is safe.
 *  - A batch the server calls malformed (400) is split to find the bad op, which is dropped and
 *    recorded on its bullet, so one bad op can never wedge the outbox.
 *  - On network/server failure: back off exponentially (while something keeps asking).
 *
 * React Native stays out: triggers (foreground, network change, background task) live in
 * triggers.ts and just call `requestSync()`.
 */

import {
  type AudioUploadState,
  MAX_AUDIO_CHUNK_BYTES,
  MAX_PUSH_OPS,
  type PushOpResult,
} from '@bullet/core'
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { PhoneDb } from '../data/db'
import { applyPull, CURSOR_KEY, getState, setState } from '../data/mirror'
import { audioAttachments, bullets, outbox } from '../data/schema'
import { type SyncTransport, TransportError } from './transport'

export type SyncOutcome =
  | { ok: true; pushed: number; uploaded: number; pulled: number }
  | { ok: false; error: TransportError; pushed: number; uploaded: number; pulled: number }

export interface SyncClientOptions {
  db: PhoneDb
  /** Resolved lazily: null while the device is not paired with a server. */
  transport: () => SyncTransport | null
  now?: () => number
  pullLimit?: number
  /** Notified after each sync that changed local data (screens re-query). */
  onChange?: () => void
  /** Backoff after a failed sync: `min(maxMs, baseMs * 2^(failures-1))`. */
  backoff?: { baseMs: number; maxMs: number }
  /** Reads part of a local recording; without it, recordings are not uploaded. */
  readAudioChunk?: (localPath: string, offset: number, length: number) => Promise<Uint8Array>
  audioChunkBytes?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface SyncClient {
  /** Run a sync now (or join the running one). */
  sync(): Promise<SyncOutcome | null>
  /** Sync soon; failures schedule a backed-off retry. Use this from triggers. */
  requestSync(): void
  /** Ops waiting to be sent. */
  pendingCount(): number
  dispose(): void
}

const PUSH_BATCH = Math.min(50, MAX_PUSH_OPS)

/** A recording file on this phone couldn't be read (not a server or network problem). */
class LocalReadError extends Error {}

/** Sync-state key holding why a recording couldn't be read for upload ('' once it uploads). */
export const audioReadErrorKey = (attachmentId: string) => `audio_read_error:${attachmentId}`

export function createSyncClient(opts: SyncClientOptions): SyncClient {
  const { db } = opts
  const now = opts.now ?? Date.now
  const backoff = opts.backoff ?? { baseMs: 2_000, maxMs: 5 * 60_000 }
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))

  let running: Promise<SyncOutcome | null> | null = null
  let again = false
  let failures = 0
  let retryTimer: unknown = null
  let disposed = false

  /** Record the server's answers: acked ops leave the outbox; refusals are noted on the bullet. */
  function settle(batch: (typeof outbox.$inferSelect)[], results: PushOpResult[]): number {
    const byId = new Map(results.map((r) => [r.op_id, r]))
    let settled = 0
    db.transaction((tx) => {
      for (const row of batch) {
        const r = byId.get(row.op_id)
        if (!r) continue
        if (r.status === 'rejected') noteRejection(tx, row, `${r.error.code}: ${r.error.message}`)
        tx.delete(outbox).where(eq(outbox.seq, row.seq)).run()
        settled += 1
      }
    })
    return settled
  }

  function noteRejection(tx: PhoneDb, row: typeof outbox.$inferSelect, reason: string) {
    if (row.bullet_id) {
      tx.update(bullets).set({ sync_rejection: reason }).where(eq(bullets.id, row.bullet_id)).run()
    }
  }

  async function pushAll(t: SyncTransport): Promise<number> {
    let pushed = 0
    for (;;) {
      const batch = db.select().from(outbox).orderBy(asc(outbox.seq)).limit(PUSH_BATCH).all()
      if (batch.length === 0) return pushed
      db.update(outbox)
        .set({ attempts: sql`${outbox.attempts} + 1` })
        .where(
          inArray(
            outbox.seq,
            batch.map((r) => r.seq),
          ),
        )
        .run()
      try {
        const res = await t.push({ ops: batch.map((r) => r.op) })
        const settled = settle(batch, res.results)
        pushed += settled
        if (settled === 0) throw new TransportError('server', 'server acknowledged no ops')
      } catch (err) {
        if (!(err instanceof TransportError) || err.kind !== 'bad_request') throw err
        pushed += await isolateBadOps(t, batch)
      }
    }
  }

  /** A 400 on a batch: send ops one by one; drop (and note) the ones the server can't parse. */
  async function isolateBadOps(t: SyncTransport, batch: (typeof outbox.$inferSelect)[]) {
    let pushed = 0
    for (const row of batch) {
      try {
        const res = await t.push({ ops: [row.op] })
        pushed += settle([row], res.results)
      } catch (err) {
        if (!(err instanceof TransportError) || err.kind !== 'bad_request') throw err
        db.transaction((tx) => {
          noteRejection(tx, row, `malformed: ${err.message}`)
          tx.delete(outbox).where(eq(outbox.seq, row.seq)).run()
        })
      }
    }
    return pushed
  }

  /** Upload one recording from wherever the server's copy stops. Throws TransportError. */
  async function uploadOne(
    t: SyncTransport,
    row: typeof audioAttachments.$inferSelect,
    read: NonNullable<SyncClientOptions['readAudioChunk']>,
  ) {
    const chunk = opts.audioChunkBytes ?? MAX_AUDIO_CHUNK_BYTES
    let state: AudioUploadState = await t.audioStatus(row.id)
    let conflicts = 0
    while (state.upload_status !== 'uploaded') {
      const length = Math.min(chunk, state.size_bytes - state.received_bytes)
      let bytes: Uint8Array
      try {
        bytes = await read(row.local_path as string, state.received_bytes, length)
      } catch (err) {
        throw new LocalReadError(String(err))
      }
      try {
        state = await t.uploadAudio(row.id, state.received_bytes, bytes)
      } catch (err) {
        // Someone else moved the offset (a parallel attempt): re-read it and carry on.
        if (err instanceof TransportError && err.kind === 'conflict' && conflicts++ < 3) {
          state = await t.audioStatus(row.id)
          continue
        }
        throw err
      }
      db.update(audioAttachments)
        .set({ received_bytes: state.received_bytes, upload_status: state.upload_status })
        .where(eq(audioAttachments.id, row.id))
        .run()
    }
    db.update(audioAttachments)
      .set({ received_bytes: state.received_bytes, upload_status: 'uploaded' })
      .where(eq(audioAttachments.id, row.id))
      .run()
  }

  /** Upload pending recordings whose bullet the server has already accepted. */
  async function uploadAll(t: SyncTransport): Promise<number> {
    const read = opts.readAudioChunk
    if (!read) return 0
    const unacked = new Set(
      db
        .select({ bullet_id: outbox.bullet_id })
        .from(outbox)
        .where(eq(outbox.type, 'bullet.create'))
        .all()
        .map((r) => r.bullet_id),
    )
    const pending = db
      .select()
      .from(audioAttachments)
      .where(
        and(
          eq(audioAttachments.upload_status, 'pending'),
          eq(audioAttachments.state, 'active'),
          isNotNull(audioAttachments.local_path),
        ),
      )
      .all()
      .filter((a) => !unacked.has(a.bullet_id))
    let uploaded = 0
    for (const row of pending) {
      try {
        await uploadOne(t, row, read)
        uploaded += 1
        if (getState(db, audioReadErrorKey(row.id))) {
          setState(db, audioReadErrorKey(row.id), '')
        }
      } catch (err) {
        // This phone can't read the file (moved, deleted, damaged): keep it pending, note why,
        // and go on with the others. One bad file must not hold back every later recording.
        if (err instanceof LocalReadError) {
          setState(db, audioReadErrorKey(row.id), err.message)
          continue
        }
        // Checksum mismatch (server restarted it at 0) or unknown to the server: try next sync.
        if (
          err instanceof TransportError &&
          (err.kind === 'unprocessable' || err.kind === 'not_found')
        )
          continue
        throw err
      }
    }
    return uploaded
  }

  async function pullAll(t: SyncTransport): Promise<number> {
    let pulled = 0
    for (;;) {
      const cursor = getState(db, CURSOR_KEY)
      const page = await t.pull({ cursor, limit: opts.pullLimit })
      applyPull(db, page)
      pulled += Object.values(page.changes).reduce((n, rows) => n + rows.length, 0)
      if (!page.has_more) return pulled
    }
  }

  async function runOnce(): Promise<SyncOutcome | null> {
    const t = opts.transport()
    if (!t) return null
    let pushed = 0
    let uploaded = 0
    let pulled = 0
    try {
      pushed = await pushAll(t)
      uploaded = await uploadAll(t)
      pulled = await pullAll(t)
      setState(db, 'last_sync_at', String(now()))
      return { ok: true, pushed, uploaded, pulled }
    } catch (err) {
      const error = err instanceof TransportError ? err : new TransportError('server', String(err))
      return { ok: false, error, pushed, uploaded, pulled }
    } finally {
      if (pushed + uploaded + pulled > 0) opts.onChange?.()
    }
  }

  function sync(): Promise<SyncOutcome | null> {
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      let outcome: SyncOutcome | null
      do {
        again = false
        outcome = await runOnce()
      } while (again && outcome?.ok)
      return outcome
    })().finally(() => {
      running = null
    })
    return running
  }

  function scheduleRetry() {
    if (disposed || retryTimer !== null) return
    const delay = Math.min(backoff.maxMs, backoff.baseMs * 2 ** (failures - 1))
    retryTimer = setTimer(() => {
      retryTimer = null
      requestSync()
    }, delay)
  }

  function requestSync() {
    if (disposed) return
    if (retryTimer !== null) {
      clearTimer(retryTimer)
      retryTimer = null
    }
    void sync().then((outcome) => {
      if (!outcome) return
      if (outcome.ok) {
        failures = 0
      } else if (outcome.error.kind !== 'unauthorized') {
        failures += 1
        scheduleRetry()
      }
    })
  }

  return {
    sync,
    requestSync,
    pendingCount: () =>
      db
        .select({ n: sql<number>`count(*)` })
        .from(outbox)
        .get()?.n ?? 0,
    dispose() {
      disposed = true
      if (retryTimer !== null) clearTimer(retryTimer)
      retryTimer = null
    },
  }
}
