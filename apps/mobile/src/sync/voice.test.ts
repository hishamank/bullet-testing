import { pushOpSchema } from '@bullet/core'
import { describe, expect, test } from 'vite-plus/test'
import { captureVoiceBullet, editBullet, type VoiceCaptureInput } from '../data/local'
import { getState } from '../data/mirror'
import { listBullets } from '../data/queries'
import { audioAttachments, bullets, outbox, transcripts } from '../data/schema'
import { FakeServer } from '../test/fake-server'
import { openTestDb, testDeps } from '../test/db'
import { audioReadErrorKey, createSyncClient } from './client'
import { TransportError } from './transport'

const FILE = Uint8Array.from({ length: 10 }, (_, i) => i + 1)

const voice = (over: Partial<VoiceCaptureInput> = {}): VoiceCaptureInput => ({
  text: 'call mom bukra',
  textEditedByUser: false,
  audio: {
    localPath: 'file:///rec/1.m4a',
    mimeType: 'audio/mp4',
    durationMs: 3000,
    sizeBytes: FILE.length,
    sha256: null,
  },
  draft: {
    text: 'call mom bukra',
    engine: 'apple-speechanalyzer',
    model: null,
    languages: ['en-US'],
  },
  ...over,
})

function setup() {
  const db = openTestDb()
  const server = new FakeServer()
  const reads: [number, number][] = []
  const client = createSyncClient({
    db,
    transport: () => server,
    audioChunkBytes: 4,
    readAudioChunk: async (path, offset, length) => {
      expect(path).toBe('file:///rec/1.m4a')
      reads.push([offset, length])
      return FILE.slice(offset, offset + length)
    },
  })
  return { db, server, client, deps: testDeps(), reads }
}

describe('voice capture on the phone', () => {
  test('bullet + recording + draft + outbox op in one transaction; the op carries audio + draft', () => {
    const { db, deps } = setup()
    const id = captureVoiceBullet(db, voice({ text: 'call Mom', textEditedByUser: true }), deps)
    expect(db.select().from(bullets).get()).toMatchObject({
      id,
      source: 'voice',
      text: 'call Mom',
      text_edited_by_user: true,
    })
    expect(db.select().from(audioAttachments).get()).toMatchObject({
      bullet_id: id,
      local_path: 'file:///rec/1.m4a',
      upload_status: 'pending',
    })
    expect(db.select().from(transcripts).get()).toMatchObject({
      kind: 'device_draft',
      text: 'call mom bukra',
    })
    const op = db.select().from(outbox).get()?.op
    expect(pushOpSchema.safeParse(op).success).toBe(true)
    expect(op).toMatchObject({
      bullet: { source: 'voice', text_edited_by_user: true, audio: { size_bytes: 10 } },
    })
  })

  test('a failed outbox write rolls back the recording rows too', () => {
    const { db, deps } = setup()
    const ids = ['b1', 'a1', 't1', 'op', 'b2', 'a2', 't2', 'op']
    const scripted = { ...deps, uuid: () => ids.shift() ?? '' }
    captureVoiceBullet(db, voice(), scripted)
    expect(() => captureVoiceBullet(db, voice(), scripted)).toThrow()
    expect(db.select().from(audioAttachments).all()).toHaveLength(1)
    expect(db.select().from(transcripts).all()).toHaveLength(1)
  })

  test('editing a voice bullet marks the text as the user’s', () => {
    const { db, deps } = setup()
    const id = captureVoiceBullet(db, voice(), deps)
    editBullet(db, id, 'call mom tomorrow', deps)
    expect(db.select().from(bullets).get()?.text_edited_by_user).toBe(true)
  })
})

describe('recording upload', () => {
  test('uploads in chunks after the bullet is acked, then marks it uploaded', async () => {
    const { db, server, client, deps, reads } = setup()
    captureVoiceBullet(db, voice(), deps)
    const outcome = await client.sync()
    expect(outcome).toMatchObject({ ok: true, pushed: 1, uploaded: 1 })
    expect(reads).toEqual([
      [0, 4],
      [4, 4],
      [8, 2],
    ])
    const [audio] = [...server.audio.values()]
    expect(Uint8Array.from(audio?.bytes ?? [])).toEqual(FILE)
    expect(db.select().from(audioAttachments).get()).toMatchObject({
      upload_status: 'uploaded',
      received_bytes: 10,
    })
  })

  test('an unreadable file is skipped (and noted); later recordings still upload', async () => {
    const db = openTestDb()
    const server = new FakeServer()
    const client = createSyncClient({
      db,
      transport: () => server,
      audioChunkBytes: 4,
      readAudioChunk: async (path, offset, length) => {
        if (path.endsWith('gone.wav')) throw new Error('no such file')
        return FILE.slice(offset, offset + length)
      },
    })
    const deps = testDeps()
    const audio = voice().audio
    captureVoiceBullet(db, voice({ audio: { ...audio, localPath: 'recordings/gone.wav' } }), deps)
    deps.clock.now += 1
    captureVoiceBullet(db, voice({ audio: { ...audio, localPath: 'recordings/ok.wav' } }), deps)
    const outcome = await client.sync()
    expect(outcome).toMatchObject({ ok: true, pushed: 2, uploaded: 1 })
    const rows = db.select().from(audioAttachments).all()
    const gone = rows.find((a) => a.local_path === 'recordings/gone.wav')
    expect(gone?.upload_status).toBe('pending')
    expect(rows.find((a) => a.local_path === 'recordings/ok.wav')?.upload_status).toBe('uploaded')
    expect(getState(db, audioReadErrorKey(gone?.id ?? ''))).toMatch(/no such file/)
  })

  test('never uploads before the server has accepted the bullet', async () => {
    const { db, server, client, deps } = setup()
    captureVoiceBullet(db, voice(), deps)
    server.failNext = { count: 1, error: new TransportError('network', 'offline') }
    await client.sync()
    expect(server.uploadCalls).toBe(0)
  })

  test('an interrupted upload resumes where the server stopped', async () => {
    const { db, server, client, deps, reads } = setup()
    captureVoiceBullet(db, voice(), deps)
    server.failUploadCall = 2 // the second chunk is lost
    expect((await client.sync())?.ok).toBe(false)
    expect(db.select().from(audioAttachments).get()).toMatchObject({
      upload_status: 'pending',
      received_bytes: 4,
    })
    reads.length = 0
    expect((await client.sync())?.ok).toBe(true)
    expect(reads[0]).toEqual([4, 4]) // resumed at the server's offset, not from 0
    expect(db.select().from(audioAttachments).get()?.upload_status).toBe('uploaded')
  })

  test('a transcribing bullet shows transcribing', async () => {
    const { db, server, client, deps } = setup()
    const id = captureVoiceBullet(db, voice(), deps)
    await client.sync()
    server.process(id, 'transcribing')
    await client.sync()
    expect(listBullets(db)[0]?.status).toBe('transcribing')
  })
})

describe('pull merge for recordings', () => {
  test('server upload state + transcripts arrive; the local file path is kept', async () => {
    const { db, deps } = setup()
    const id = captureVoiceBullet(db, voice(), deps)
    const local = db.select().from(audioAttachments).get()
    const { applyPull } = await import('../data/mirror')
    const base = {
      owner_id: '00000000-0000-4000-8000-0000000000aa',
      created_at: 1,
      updated_at: 2,
      state: 'active' as const,
    }
    applyPull(db, {
      cursor: '9',
      has_more: false,
      server_time: 2,
      changes: {
        bullets: [],
        suggestions: [],
        tasks: [],
        events: [],
        trackers: [],
        tracker_entries: [],
        activities: [],
        audio_attachments: [
          {
            ...base,
            id: local?.id ?? '',
            bullet_id: id,
            mime_type: 'audio/mp4',
            duration_ms: 3000,
            size_bytes: 10,
            sha256: null,
            upload_status: 'uploaded',
            received_bytes: 10,
          },
        ],
        thoughts: [],
        questions: [],
        thought_links: [],
        themes: [],
        theme_thoughts: [],
        noticed_cards: [],
        transcripts: [
          {
            ...base,
            id: '00000000-0000-4000-8000-0000000000bb',
            bullet_id: id,
            attachment_id: local?.id ?? '',
            kind: 'server',
            text: 'call mom tomorrow, yalla',
            engine: 'whisper.cpp',
            model: 'large-v3-turbo',
            languages: ['en', 'ar'],
            transcribed_at: 2,
          },
        ],
      },
    })
    expect(db.select().from(audioAttachments).get()).toMatchObject({
      upload_status: 'uploaded',
      local_path: 'file:///rec/1.m4a',
    })
    expect(
      db
        .select()
        .from(transcripts)
        .all()
        .map((t) => t.kind)
        .sort(),
    ).toEqual(['device_draft', 'server'])
  })
})
