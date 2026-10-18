import { createHash } from 'node:crypto'
import { pushOpSchema } from '@bullet/core'
import { describe, expect, test } from 'vite-plus/test'
import { eq } from 'drizzle-orm'
import { captureBullet } from '../../data/local'
import {
  audioAttachments,
  bullets,
  outbox,
  questions,
  thoughts,
  transcripts,
} from '../../data/schema'
import { openTestDb, T0, testDeps } from '../../test/db'
import {
  createRecovery,
  discardSession,
  recoverRecordings,
  saveVoiceNote,
  segmentName,
  sessionDir,
  voiceNoteText,
  writeSessionMeta,
} from './save'
import { memoryIo, wavFile } from './test-io'
import { parseWav } from './wav'

const ROOT = 'file:///docs/recordings/'
const S1 = '11111111-1111-4111-8111-111111111111'
const S2 = '22222222-2222-4222-8222-222222222222'
const Q1 = '33333333-3333-4333-8333-333333333333'
const LOOP = '44444444-4444-4444-8444-444444444444'

function setup() {
  const db = openTestDb()
  const io = memoryIo()
  const deps = { db, io, local: testDeps(), root: ROOT }
  const dir = sessionDir(ROOT, S1)
  io.ensureDir(dir)
  return { db, io, deps, dir }
}

describe('saving a voice note', () => {
  test('joins the stretches into one kept WAV and saves bullet + attachment + draft + op', async () => {
    const { db, io, deps, dir } = setup()
    io.create(`${dir}${segmentName(1)}`, wavFile(16_000, { fill: 1 }))
    io.create(`${dir}${segmentName(2)}`, wavFile(16_000, { fill: 2, stale: true }))
    const id = await saveVoiceNote(
      deps,
      S1,
      {
        files: [`${dir}seg-001.wav`, `${dir}seg-002.wav`],
        mimeType: 'audio/wav',
        draft: 'dentist Thursday at three',
        liveDraft: true,
        recordedMs: 2_100,
      },
      {},
    )
    const out = `${ROOT}${S1}.wav`
    const joined = io.files.get(out) ?? new Uint8Array()
    const sha = createHash('sha256').update(joined).digest('hex')
    expect(parseWav(joined, joined.length)?.dataBytes).toBe(64_000)
    expect(joined[44]).toBe(1)
    expect(joined.at(-1)).toBe(2)
    // The session folder goes once the bullet owns the joined file.
    expect([...io.files.keys()]).toEqual([out])

    expect(db.select().from(bullets).get()).toMatchObject({
      id,
      source: 'voice',
      text: 'dentist Thursday at three',
      text_edited_by_user: false,
    })
    expect(db.select().from(audioAttachments).get()).toMatchObject({
      // Relative to Documents: survives the iOS container path changing on update/reinstall.
      local_path: `recordings/${S1}.wav`,
      mime_type: 'audio/wav',
      duration_ms: 2_000,
      size_bytes: 64_044,
      sha256: sha,
      upload_status: 'pending',
    })
    expect(db.select().from(transcripts).get()).toMatchObject({
      kind: 'device_draft',
      text: 'dentist Thursday at three',
      languages: ['en-US'],
    })
    expect(pushOpSchema.parse(db.select().from(outbox).get()?.op)).toMatchObject({
      type: 'bullet.create',
      bullet: { id, source: 'voice', audio: { size_bytes: 64_044, duration_ms: 2_000 } },
    })
  })

  test('no live draft: a placeholder text the server transcript will replace', async () => {
    const { db, io, deps, dir } = setup()
    io.create(`${dir}seg-001.wav`, wavFile(16_000 * 75))
    await saveVoiceNote(
      deps,
      S1,
      {
        files: [`${dir}seg-001.wav`],
        mimeType: 'audio/wav',
        draft: '',
        liveDraft: false,
        recordedMs: 0,
      },
      { answersQuestionId: undefined },
    )
    expect(db.select().from(bullets).get()?.text).toBe('Voice note, 1:15')
    expect(db.select().from(transcripts).get()).toMatchObject({ text: '', languages: [] })
  })

  test('a single-file (m4a) recording is moved into place and keeps its length', async () => {
    const { db, io, deps } = setup()
    io.create('file:///docs/ExpoAudio/rec.m4a', new Uint8Array(500))
    await saveVoiceNote(
      deps,
      S1,
      {
        files: ['file:///docs/ExpoAudio/rec.m4a'],
        mimeType: 'audio/mp4',
        draft: '',
        liveDraft: false,
        recordedMs: 4_200.4,
      },
      {},
    )
    expect(io.exists('file:///docs/ExpoAudio/rec.m4a')).toBe(false)
    expect(db.select().from(audioAttachments).get()).toMatchObject({
      local_path: `recordings/${S1}.m4a`,
      mime_type: 'audio/mp4',
      duration_ms: 4_200,
      size_bytes: 500,
    })
  })

  test('an m4a recording that had to restart: every file is kept, as its own voice note', async () => {
    const { db, io, deps } = setup()
    io.create('file:///a.m4a', new Uint8Array(500))
    io.create('file:///b.m4a', new Uint8Array(300))
    const first = await saveVoiceNote(
      deps,
      S1,
      {
        files: ['file:///a.m4a', 'file:///b.m4a'],
        mimeType: 'audio/mp4',
        draft: '',
        liveDraft: false,
        recordedMs: 9_000,
      },
      {},
    )
    const saved = db.select().from(audioAttachments).all()
    expect(saved.map((a) => [a.local_path, a.size_bytes])).toEqual([
      [`recordings/${S1}.m4a`, 500],
      [`recordings/${S1}-2.m4a`, 300],
    ])
    expect(saved[0]?.bullet_id).toBe(first)
  })

  test('nothing audible → nothing saved', async () => {
    const { db, io, deps, dir } = setup()
    io.create(`${dir}seg-001.wav`, wavFile(0))
    const id = await saveVoiceNote(
      deps,
      S1,
      {
        files: [`${dir}seg-001.wav`],
        mimeType: 'audio/wav',
        draft: '',
        liveDraft: true,
        recordedMs: 0,
      },
      {},
    )
    expect(id).toBeNull()
    expect(db.select().from(bullets).all()).toEqual([])
  })

  test('cancel removes the session and its files', () => {
    const { io, deps, dir } = setup()
    io.create(`${dir}seg-001.wav`, wavFile(10))
    io.create('file:///docs/ExpoAudio/rec.m4a', new Uint8Array(5))
    discardSession(deps, S1, ['file:///docs/ExpoAudio/rec.m4a'])
    expect(io.files.size).toBe(0)
  })

  test('placeholder text', () => {
    expect(voiceNoteText('  ', 3_723_000)).toBe('Voice note, 1:02:03')
    expect(voiceNoteText(' hi ', 0)).toBe('hi')
  })
})

describe('recovering after a crash', () => {
  test('a recording killed mid-way is saved with its links, draft and start time', async () => {
    const { db, io, deps, dir } = setup()
    // The capture the answered question and the closed loop came from.
    const from = captureBullet(db, { text: 'passport, dentist thursday' }, testDeps())
    const row = { created_at: T0, updated_at: T0, source_bullet_id: from }
    db.insert(questions)
      .values({
        ...row,
        id: Q1,
        kind: 'clarifying',
        topic: 'date',
        text: 'Which Thursday?',
        options: [],
        status: 'open',
      })
      .run()
    db.insert(thoughts)
      .values({
        ...row,
        id: LOOP,
        position: 0,
        text: 'check passport',
        kind: 'to_check',
        kind_source: 'engine',
      })
      .run()
    writeSessionMeta(deps, {
      id: S1,
      startedAt: T0 - 60_000,
      links: { answersQuestionId: Q1, resolvesThoughtId: LOOP },
      draft: 'passport before March',
      liveDraft: true,
    })
    io.create(`${dir}seg-002.wav`, wavFile(8_000, { stale: true, fill: 2 }))
    io.create(`${dir}seg-001.wav`, wavFile(8_000, { fill: 1 }))
    const [id = ''] = await recoverRecordings(deps)
    expect(db.select().from(bullets).where(eq(bullets.id, id)).get()).toMatchObject({
      text: 'passport before March',
      captured_at: T0 - 60_000,
      answers_question_id: Q1,
      resolves_thought_id: LOOP,
    })
    expect(db.select().from(thoughts).get()).toMatchObject({ resolved_by_bullet_id: id })
    const joined = io.files.get(`${ROOT}${S1}.wav`) ?? new Uint8Array()
    expect(joined[44]).toBe(1) // seg-001 first
    expect(parseWav(joined, joined.length)?.dataBytes).toBe(32_000)
    expect(io.exists(dir)).toBe(false)
  })

  test('saved but killed before tidying: no duplicate, just tidy', async () => {
    const { db, io, deps, dir } = setup()
    io.create(`${dir}seg-001.wav`, wavFile(100))
    await saveVoiceNote(
      deps,
      S1,
      {
        files: [`${dir}seg-001.wav`],
        mimeType: 'audio/wav',
        draft: 'x',
        liveDraft: true,
        recordedMs: 0,
      },
      {},
    )
    io.ensureDir(dir)
    io.create(`${dir}seg-001.wav`, wavFile(100))
    expect(await recoverRecordings(deps)).toEqual([])
    expect(db.select().from(bullets).all()).toHaveLength(1)
    expect(io.exists(dir)).toBe(false)
  })

  test('a row saved with an old absolute path still counts as saved', async () => {
    const { db, io, deps, dir } = setup()
    io.create(`${dir}seg-001.wav`, wavFile(100))
    await saveVoiceNote(
      deps,
      S1,
      {
        files: [`${dir}seg-001.wav`],
        mimeType: 'audio/wav',
        draft: 'x',
        liveDraft: true,
        recordedMs: 0,
      },
      {},
    )
    db.update(audioAttachments)
      .set({ local_path: `file:///old-container/Documents/recordings/${S1}.wav` })
      .run()
    io.ensureDir(dir)
    io.create(`${dir}seg-001.wav`, wavFile(100))
    expect(await recoverRecordings(deps)).toEqual([])
    expect(db.select().from(bullets).all()).toHaveLength(1)
  })

  test('the active session and empty sessions: skipped / removed', async () => {
    const { db, io, deps, dir } = setup()
    io.create(`${dir}seg-001.wav`, wavFile(100))
    const other = sessionDir(ROOT, 'empty')
    io.ensureDir(other)
    expect(await recoverRecordings(deps, new Set([S1]))).toEqual([])
    expect(io.exists(`${dir}seg-001.wav`)).toBe(true)
    expect(io.exists(other)).toBe(false)
    expect(db.select().from(bullets).all()).toEqual([])
  })
})

describe('recovering at app start', () => {
  function leftover(deps: ReturnType<typeof setup>['deps'], id: string, draft: string) {
    const dir = sessionDir(ROOT, id)
    deps.io.ensureDir(dir)
    writeSessionMeta(deps, { id, startedAt: T0, links: {}, draft, liveDraft: true })
    deps.io.create(`${dir}seg-001.wav`, wavFile(1_000, { fill: 1 }))
    return dir
  }

  test('overlapping calls share one run: each leftover is saved once', async () => {
    const { db, deps } = setup()
    leftover(deps, S1, 'from the crash')
    const recover = createRecovery(() => deps, new Set())
    const first = recover()
    const second = recover()
    expect(second).toBe(first)
    expect(await first).toHaveLength(1)
    expect(db.select().from(bullets).all()).toHaveLength(1)
    // Once the run ends, a later call runs again (nothing left to save).
    expect(await recover()).toEqual([])
  })

  test('skips the recording that is in progress, and saves it later if it is left behind', async () => {
    const { db, io, deps } = setup()
    leftover(deps, S1, 'from the crash')
    const liveDir = leftover(deps, S2, 'recording now')
    const live = new Set([S2])
    const recover = createRecovery(() => deps, live)
    expect(await recover()).toHaveLength(1)
    expect(
      db
        .select()
        .from(bullets)
        .all()
        .map((b) => b.text),
    ).toEqual(['from the crash'])
    expect(io.exists(`${liveDir}seg-001.wav`)).toBe(true)

    live.delete(S2)
    expect(await recover()).toHaveLength(1)
    expect(db.select().from(bullets).all()).toHaveLength(2)
  })

  test('a recording that starts mid-run is skipped when its folder is reached', async () => {
    const { db, io, deps } = setup()
    leftover(deps, S1, 'from the crash')
    const s2Dir = leftover(deps, S2, 'started during recovery')
    const live = new Set<string>()
    // S2 goes live while recovery is reading S1, after the folders were listed.
    const readText = io.readText
    const watched = {
      ...deps,
      io: {
        ...io,
        readText: (uri: string) => {
          if (uri === `${sessionDir(ROOT, S1)}meta.json`) live.add(S2)
          return readText(uri)
        },
      },
    }
    expect(await createRecovery(() => watched, live)()).toHaveLength(1)
    expect(
      db
        .select()
        .from(bullets)
        .all()
        .map((b) => b.text),
    ).toEqual(['from the crash'])
    expect(io.exists(`${s2Dir}seg-001.wav`)).toBe(true)
  })
})
