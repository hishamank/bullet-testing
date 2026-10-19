/**
 * Opt-in end-to-end harness: a headless "phone" (the real local data layer on an in-memory
 * SQLite, the real sync client and HTTP transport) against a REAL home server (bullet server +
 * llama-server + whisper-server). Only used by `*.e2e.test.ts`, which skip unless
 * `BULLET_E2E_URL` is set. See docs/e2e-results.md for how to run it.
 */

import { createHash, randomUUID } from 'node:crypto'
import { execSync } from 'node:child_process'
import { appendFileSync, openSync, readSync, closeSync, readFileSync } from 'node:fs'
import type { ServerBulletProcessingStatus } from '@bullet/core'
import { eq } from 'drizzle-orm'
import type { PhoneDb } from '../../data/db'
import type { LocalDeps } from '../../data/local'
import { bullets } from '../../data/schema'
import { createSyncClient, type SyncClient } from '../../sync/client'
import { createHttpTransport, type SyncTransport } from '../../sync/transport'
import { openTestDb } from '../db'

export const E2E = {
  url: process.env.BULLET_E2E_URL,
  token: process.env.BULLET_E2E_TOKEN ?? '',
  /**
   * A WAV of synthetic speech (e.g. espeak-ng) and words its transcript must contain. Without it
   * the two voice-transcript tests are skipped.
   */
  speechWav: process.env.BULLET_E2E_SPEECH_WAV,
  speechWords: (process.env.BULLET_E2E_SPEECH_WORDS ?? 'olive')
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean),
  /** Shell commands that stop / start llama-server, for the outage test. */
  llmStop: process.env.BULLET_E2E_LLM_STOP,
  llmStart: process.env.BULLET_E2E_LLM_START,
  /** JSON-lines file receiving one record per measurement / quality note. */
  report: process.env.BULLET_E2E_REPORT,
  timezone: process.env.BULLET_E2E_TZ ?? 'Asia/Beirut',
}

export const enabled = Boolean(E2E.url)

/** One line of the run report (latencies, observed transitions, extraction-quality notes). */
export function record(entry: Record<string, unknown>): void {
  const line = { at: new Date().toISOString(), ...entry }
  console.log('[e2e]', JSON.stringify(line))
  if (E2E.report) appendFileSync(E2E.report, `${JSON.stringify(line)}\n`)
}

/** A quality expectation about the model's output: recorded, never failing the run. */
export function quality(name: string, ok: boolean, detail: unknown): boolean {
  record({ type: 'quality', name, ok, detail })
  return ok
}

export function readChunk(localPath: string, offset: number, length: number): Promise<Uint8Array> {
  const fd = openSync(localPath, 'r')
  try {
    const buf = Buffer.alloc(length)
    const n = readSync(fd, buf, 0, length, offset)
    return Promise.resolve(new Uint8Array(buf.subarray(0, n)))
  } finally {
    closeSync(fd)
  }
}

export interface Phone {
  db: PhoneDb
  deps: LocalDeps
  client: SyncClient
  transport: SyncTransport
  /** One sync run; throws when it fails. */
  sync(): Promise<void>
}

export function createPhone(
  opts: { wrap?: (t: SyncTransport) => SyncTransport; chunkBytes?: number } = {},
): Phone {
  const db = openTestDb()
  const deps: LocalDeps = {
    now: () => Date.now(),
    uuid: () => randomUUID(),
    timezone: () => E2E.timezone,
  }
  const http = createHttpTransport({
    baseUrl: E2E.url ?? '',
    token: E2E.token,
    timeoutMs: 60_000,
  })
  const transport = opts.wrap ? opts.wrap(http) : http
  const client = createSyncClient({
    db,
    transport: () => transport,
    readAudioChunk: readChunk,
    audioChunkBytes: opts.chunkBytes,
  })
  return {
    db,
    deps,
    client,
    transport,
    async sync() {
      const out = await client.sync()
      if (!out) throw new Error('sync client has no transport')
      if (!out.ok) throw out.error
    },
  }
}

export function serverStatus(p: Phone, bulletId: string) {
  return p.db.select().from(bullets).where(eq(bullets.id, bulletId)).get()
}

export interface Watch {
  /** Every status seen, with ms since the watch started. */
  seen: { status: ServerBulletProcessingStatus | null; ms: number; attempts: number }[]
  ms: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Sync every `everyMs` until `done(bullet)` holds; records each status transition. Throws with the
 * transitions seen when it times out.
 */
export async function syncUntil(
  p: Phone,
  bulletId: string,
  done: (b: NonNullable<ReturnType<typeof serverStatus>>) => boolean,
  timeoutMs: number,
  everyMs = 1_000,
): Promise<Watch> {
  const t0 = Date.now()
  const seen: Watch['seen'] = []
  for (;;) {
    try {
      await p.sync()
    } catch (err) {
      // A failed sync (server briefly unreachable) is just retried on the next tick.
      seen.push({ status: null, ms: Date.now() - t0, attempts: -1 })
      record({ type: 'sync_error', bulletId, error: String(err) })
    }
    const b = serverStatus(p, bulletId)
    const last = seen.at(-1)
    if (b && (last?.status !== b.server_status || last.attempts !== b.server_attempts)) {
      seen.push({ status: b.server_status, ms: Date.now() - t0, attempts: b.server_attempts })
    }
    if (b && done(b)) return { seen, ms: Date.now() - t0 }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting on ${bulletId}; seen ${JSON.stringify(seen)}; last ${JSON.stringify(b)}`,
      )
    }
    await sleep(everyMs)
  }
}

export const isSettled = (b: { server_status: string | null }) =>
  b.server_status === 'processed' ||
  b.server_status === 'needs_review' ||
  b.server_status === 'failed'

export function runShell(cmd: string): void {
  execSync(cmd, { stdio: 'inherit', shell: '/bin/bash' })
}

/** Wait until an HTTP endpoint answers 200 (used after restarting llama-server). */
export async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const t0 = Date.now()
  for (;;) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      // not up yet
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`${url} not up after ${timeoutMs}ms`)
    await sleep(500)
  }
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** A 16 kHz mono 16-bit WAV: a plain tone (no speech), for when no speech file is given. */
export function toneWav(seconds: number, hz = 440): Uint8Array {
  const rate = 16_000
  const n = Math.round(seconds * rate)
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n * 2, 4)
  buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 8000), 44 + i * 2)
  }
  return new Uint8Array(buf)
}

/** WAV duration from its header (PCM only). */
export function wavDurationMs(bytes: Uint8Array): number {
  const b = Buffer.from(bytes)
  const byteRate = b.readUInt32LE(28)
  let off = 12
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4)
    const size = b.readUInt32LE(off + 4)
    if (id === 'data') return Math.round((Math.min(size, b.length - off - 8) / byteRate) * 1000)
    off += 8 + size
  }
  return 0
}

export function readBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path))
}

/** Local wall-clock parts of `at` in `timeZone`. */
export function zoned(at: number, timeZone = E2E.timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return {
    weekday: get('weekday'),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    date: `${get('year')}-${get('month')}-${get('day')}`,
  }
}
