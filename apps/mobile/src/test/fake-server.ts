/** Vitest-only: an in-memory home server speaking the sync contract (idempotent push, cursor pull). */

import type {
  AudioUploadState,
  PullChanges,
  PullResponse,
  PushOp,
  PushOpResult,
  PushRequest,
  PushResponse,
  SyncedBullet,
} from '@bullet/core'
import { TransportError, type SyncTransport } from '../sync/transport'

const OWNER = '00000000-0000-4000-8000-0000000000aa'

export class FakeServer implements SyncTransport {
  bullets = new Map<string, SyncedBullet>()
  seenOps = new Map<string, PushOpResult>()
  received: PushOp[] = []
  pushCalls = 0
  /** Changes log: [seq, bullet id]. */
  private log: [number, string][] = []
  private seq = 0
  /** Make the next N calls fail with this error (network down, etc.). */
  failNext: { count: number; error: TransportError } | null = null
  /** Apply the push, then lose the response (the phone sees a network error). */
  dropNextResponse = false
  /** Reject these op types as malformed (HTTP 400). */
  malformedTypes = new Set<string>()
  now = 1_000
  /** Recordings declared by bullet.create: declared size + bytes received so far. */
  audio = new Map<string, { size: number; bytes: number[] }>()
  uploadCalls = 0
  /** Fail the Nth upload call (1-based) with a network error, to test resuming. */
  failUploadCall: number | null = null

  private audioState(id: string): AudioUploadState {
    const a = this.audio.get(id)
    if (!a) throw new TransportError('not_found', 'no such recording', 404)
    return {
      attachment_id: id,
      size_bytes: a.size,
      received_bytes: a.bytes.length,
      upload_status: a.bytes.length === a.size ? 'uploaded' : 'pending',
    }
  }

  async audioStatus(id: string): Promise<AudioUploadState> {
    this.maybeFail()
    return this.audioState(id)
  }

  async uploadAudio(id: string, offset: number, bytes: Uint8Array): Promise<AudioUploadState> {
    this.uploadCalls += 1
    if (this.failUploadCall === this.uploadCalls) throw new TransportError('network', 'dropped')
    const state = this.audioState(id)
    if (state.upload_status === 'uploaded') return state
    if (offset !== state.received_bytes) throw new TransportError('conflict', 'offset', 409)
    this.audio.get(id)?.bytes.push(...bytes)
    return this.audioState(id)
  }

  private maybeFail() {
    if (this.failNext && this.failNext.count > 0) {
      this.failNext.count -= 1
      throw this.failNext.error
    }
  }

  private touch(id: string) {
    this.seq += 1
    this.log = this.log.filter(([, b]) => b !== id)
    this.log.push([this.seq, id])
  }

  /** Simulate the worker finishing a bullet. */
  process(id: string, status: SyncedBullet['processing']['status']) {
    const b = this.bullets.get(id)
    if (!b) throw new Error('no such bullet')
    b.processing = { ...b.processing, status, attempts: b.processing.attempts + 1 }
    this.touch(id)
  }

  async push(req: PushRequest): Promise<PushResponse> {
    this.pushCalls += 1
    this.maybeFail()
    if (req.ops.some((op) => this.malformedTypes.has(op.type))) {
      throw new TransportError('bad_request', 'malformed op', 400)
    }
    const results = req.ops.map((op): PushOpResult => {
      const seen = this.seenOps.get(op.op_id)
      if (seen) return seen.status === 'rejected' ? seen : { op_id: op.op_id, status: 'duplicate' }
      this.received.push(op)
      let result: PushOpResult = { op_id: op.op_id, status: 'applied' }
      if (op.type === 'bullet.create') {
        const { audio, ...bullet } = op.bullet
        if (audio) this.audio.set(audio.id, { size: audio.size_bytes, bytes: [] })
        this.bullets.set(op.bullet.id, {
          ...bullet,
          text_edited_by_user: bullet.text_edited_by_user ?? false,
          text_from_draft: false,
          answers_question_id: bullet.answers_question_id ?? null,
          resolves_thought_id: bullet.resolves_thought_id ?? null,
          owner_id: OWNER,
          created_at: this.now,
          updated_at: this.now,
          state: 'active',
          processing: {
            status: 'synced',
            attempts: 0,
            error: null,
            next_retry_at: null,
            updated_at: this.now,
          },
        })
        this.touch(op.bullet.id)
      } else if (op.type === 'bullet.edit') {
        const b = this.bullets.get(op.bullet_id)
        if (!b)
          result = {
            op_id: op.op_id,
            status: 'rejected',
            error: { code: 'not_found', message: 'gone' },
          }
        else {
          b.text = op.text
          b.processing.status = 'synced'
          this.touch(b.id)
        }
      } else if (op.type === 'bullet.retry') {
        result = {
          op_id: op.op_id,
          status: 'rejected',
          error: { code: 'invalid', message: 'nope' },
        }
      }
      this.seenOps.set(op.op_id, result)
      return result
    })
    if (this.dropNextResponse) {
      this.dropNextResponse = false
      throw new TransportError('network', 'connection reset')
    }
    return { results, server_time: this.now }
  }

  async pull({ cursor, limit = 500 }: { cursor?: string; limit?: number }): Promise<PullResponse> {
    this.maybeFail()
    const after = cursor ? Number(cursor) : 0
    const pending = this.log.filter(([s]) => s > after)
    const page = pending.slice(0, limit)
    const changes: PullChanges = {
      bullets: page.map(([, id]) => structuredClone(this.bullets.get(id) as SyncedBullet)),
      suggestions: [],
      tasks: [],
      events: [],
      trackers: [],
      tracker_entries: [],
      activities: [],
      audio_attachments: [],
      transcripts: [],
      thoughts: [],
      questions: [],
    }
    const last = page.at(-1)
    return {
      changes,
      cursor: String(last ? last[0] : after),
      has_more: pending.length > page.length,
      server_time: this.now,
    }
  }
}
