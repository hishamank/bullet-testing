import type { ThoughtKind } from '@bullet/core'
/** Test harness: an in-memory server with a device token, a fake clock and a scripted model. */

import type { PullResponse, PushOp, PushResponse } from '@bullet/core'
import {
  type Candidate,
  createScriptedLlmClient,
  ENGINE_CONFIG_DEFAULTS,
  type LlmClient,
  SEGMENTATION_SYSTEM_PROMPT,
} from '@bullet/engine'
import { createApp } from '../app'
import { addDevice } from '../auth/devices'
import { openDb } from '../db/client'
import { createWorker, type WorkerOptions } from '../queue/worker'
import { createMemoryAudioStore } from '../storage/audio-store'

// Thursday 2026-10-15 09:12 in Paris.
export const T0 = Date.UTC(2026, 9, 15, 7, 12)

let n = 0
/** A fresh valid UUID v4 (deterministic per test run, readable in failures). */
export const uid = (): string => {
  n += 1
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

/**
 * A scripted model that answers by bullet text: the first key contained in the prompt's bullet
 * wins. Unknown bullets yield no candidates.
 */
export function llmByText(script: Record<string, Candidate[]>) {
  return createScriptedLlmClient({
    chat: (req) => {
      const user = req.messages.find((m) => m.role === 'user')?.content ?? ''
      const bullet = /"""\n([\s\S]*?)\n"""/.exec(user)?.[1] ?? ''
      const key = Object.keys(script).find((k) => bullet.includes(k))
      return JSON.stringify({ candidates: key ? script[key] : [] })
    },
  })
}

export type SegmentScript = (capture: string) => {
  text: string
  quote?: string
  kind: ThoughtKind
  sensitive?: boolean
  entities?: string[]
}[]

/**
 * Answer the engine's SEGMENTATION calls (capture → thoughts) so tests can keep scripting just
 * extraction: by default the whole capture is one `activity` thought (an extractable kind, so the
 * extraction script still runs on the full text). Other calls go to `llm`.
 */
export function withSegmentation(llm: LlmClient, segment?: SegmentScript): LlmClient {
  return {
    chat(req) {
      if (req.messages[0]?.content !== SEGMENTATION_SYSTEM_PROMPT) return llm.chat(req)
      const capture = /"""\n([\s\S]*?)\n"""/.exec(req.messages[1]?.content ?? '')?.[1] ?? ''
      const thoughts = segment
        ? segment(capture)
        : [{ text: capture.trim(), quote: capture.trim(), kind: 'activity' as const }]
      const content = JSON.stringify({ thoughts })
      return Promise.resolve({ message: { role: 'assistant' as const, content }, raw: {} })
    },
  }
}

export function candidate(c: Partial<Candidate>): Candidate {
  return { kind: 'activity', orientation: 'happened', text: '', fields: {}, confidence: 0.9, ...c }
}

export interface Harness {
  db: ReturnType<typeof openDb>['db']
  audioStore: ReturnType<typeof createMemoryAudioStore>
  clock: { now: number }
  token: string
  ownerId: string
  push(ops: PushOp[], token?: string): Promise<PushResponse>
  pull(cursor?: string, limit?: number): Promise<PullResponse>
  request(path: string, init?: RequestInit): Promise<Response>
  worker: ReturnType<typeof createWorker>
  engine: typeof ENGINE_CONFIG_DEFAULTS
  /** Capture a bullet through the API; returns its id. */
  capture(
    text: string,
    extra?: Partial<Extract<PushOp, { type: 'bullet.create' }>['bullet']>,
  ): Promise<string>
}

export function createHarness(
  llm: LlmClient = createScriptedLlmClient({ chat: () => '{"candidates":[]}' }),
  workerOpts: Partial<WorkerOptions> = {},
  segment?: SegmentScript,
): Harness {
  const { db } = openDb(':memory:')
  const clock = { now: T0 }
  const now = () => clock.now
  const device = addDevice(db, 'test phone', now())
  const audioStore = createMemoryAudioStore()
  const worker = createWorker({
    db,
    llm: withSegmentation(llm, segment),
    engine: ENGINE_CONFIG_DEFAULTS,
    now,
    audioStore,
    ...workerOpts,
  })
  const app = createApp({ db, now, audioStore })
  const auth = (token: string) => ({ authorization: `Bearer ${token}` })

  const request = (path: string, init: RequestInit = {}) => Promise.resolve(app.request(path, init))

  const h: Harness = {
    db,
    audioStore,
    clock,
    token: device.token,
    ownerId: device.ownerId,
    worker,
    engine: ENGINE_CONFIG_DEFAULTS,
    request,
    async push(ops, token = device.token) {
      const res = await request('/sync/push', {
        method: 'POST',
        headers: { ...auth(token), 'content-type': 'application/json' },
        body: JSON.stringify({ ops }),
      })
      if (res.status !== 200) throw new Error(`push ${res.status}: ${await res.text()}`)
      return (await res.json()) as PushResponse
    },
    async pull(cursor, limit) {
      const q = new URLSearchParams()
      if (cursor !== undefined) q.set('cursor', cursor)
      if (limit !== undefined) q.set('limit', String(limit))
      const res = await request(`/sync/pull?${q}`, { headers: auth(device.token) })
      if (res.status !== 200) throw new Error(`pull ${res.status}: ${await res.text()}`)
      return (await res.json()) as PullResponse
    },
    async capture(text, extra = {}) {
      const id = uid()
      const res = await h.push([
        {
          op_id: uid(),
          type: 'bullet.create',
          bullet: { id, text, captured_at: T0, timezone: 'Europe/Paris', source: 'text', ...extra },
        },
      ])
      if (res.results[0]?.status !== 'applied') throw new Error(JSON.stringify(res.results))
      return id
    },
  }
  return h
}
