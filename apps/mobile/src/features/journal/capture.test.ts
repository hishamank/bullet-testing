import { describe, expect, test } from 'vite-plus/test'
import { undoSuggestion } from '../../data/local'
import { setState } from '../../data/mirror'
import { recordRejection } from '../../data/rejections'
import { audioReadErrorKey } from '../../sync/client'
import { openTestDb, T0, testDeps } from '../../test/db'
import {
  audioSource,
  deleteChoices,
  editableText,
  loadCaptureDetail,
  THOUGHT_KINDS,
  transcriptView,
  writeDownStart,
} from './capture'
import { keepAsAudioLocal } from './audio-only'
import {
  seedAudio,
  seedBullet,
  seedEvent,
  seedSuggestion,
  seedThought,
  seedTracker,
  seedTranscript,
  TZ,
} from './fixtures'

describe('capture detail', () => {
  test('thoughts with their things, labelled from the live thing, with state and link', () => {
    const db = openTestDb()
    const b = seedBullet(db, T0, { source: 'voice' })
    const th = seedThought(db, b, 0, 'event', 'Dentist Thursday at three')
    const mood = seedTracker(db, 'Mood', { input_type: 'scale', min: 1, max: 5 })
    const ev = seedEvent(db, Date.UTC(2026, 9, 22, 13, 0), { title: 'Dentist (moved)' })
    seedSuggestion(db, b, {
      source_thought_id: th,
      target_kind: 'event',
      payload: { title: 'Dentist', starts_at: Date.UTC(2026, 9, 15, 13, 0) },
      status: 'accepted',
      applied_entity_id: ev,
      applied_at: 2,
    })
    seedSuggestion(db, b, {
      target_kind: 'tracker_entry',
      operation: 'append',
      payload: { tracker_id: mood, value: 4, logged_at: T0 },
    })
    seedSuggestion(db, b, {
      target_kind: 'activity',
      payload: { name: 'Run', quantity: 5, unit: 'km' },
      status: 'accepted',
      auto_applied: true,
      applied_entity_id: 'not-pulled-yet',
    })
    seedSuggestion(db, b, { target_kind: 'task', payload: { title: 'x' }, status: 'rejected' })

    const d = loadCaptureDetail(db, b, T0, TZ)
    expect(d?.thoughts.map((t) => t.kind)).toEqual(['event'])
    expect(d?.things.map((t) => [t.label, t.state, t.link])).toEqual([
      ['Event · Dentist (moved) · Thu 22 Oct, 15:00', 'added', { to: 'plans', item: ev }],
      ['Mood · 4 / 5', 'review', { to: 'inbox' }],
      ['Activity · Run · 5 km', 'done_for_you', { to: 'activities', name: 'Run' }],
      ['Task · x', 'dismissed', null],
    ])
    expect(d?.things[0]?.thoughtId).toBe(th)
  })

  test('only things done for you offer Undo; a refused Undo reads calmly', () => {
    const db = openTestDb()
    const b = seedBullet(db, T0)
    const run = seedSuggestion(db, b, {
      target_kind: 'activity',
      payload: { name: 'Run', quantity: 5, unit: 'km' },
      status: 'accepted',
      auto_applied: true,
      applied_at: T0 - 3 * 86_400_000, // days ago: still undoable here
      applied_entity_id: 'not-pulled-yet',
    })
    seedSuggestion(db, b, {
      target_kind: 'task',
      payload: { title: 'Call the plumber' },
      status: 'accepted',
      applied_entity_id: 'also-not-pulled',
    })
    let d = loadCaptureDetail(db, b, T0, TZ)
    expect(d?.things.map((t) => [t.state, t.undoable])).toEqual([
      ['done_for_you', true],
      ['added', false],
    ])
    expect(d?.notices).toEqual([])

    undoSuggestion(db, run, testDeps())
    recordRejection(
      db,
      { op_id: 'op-1', type: 'suggestion.undo', suggestion_id: run, question_id: null },
      'conflict',
      'edited since',
      T0,
    )
    d = loadCaptureDetail(db, b, T0, TZ)
    expect(d?.notices.map((n) => n.text)).toEqual([
      "“Run” stays as you left it: you changed it after it was added, so Undo won't overwrite your edit.",
    ])
  })

  test('a deleted thing reads as deleted and links nowhere', () => {
    const db = openTestDb()
    const b = seedBullet(db, T0)
    const ev = seedEvent(db, T0, { state: 'deleted' })
    seedSuggestion(db, b, {
      target_kind: 'event',
      payload: { title: 'Gone' },
      status: 'accepted',
      applied_entity_id: ev,
    })
    expect(loadCaptureDetail(db, b, T0, TZ)?.things[0]).toMatchObject({
      state: 'removed',
      link: null,
    })
  })

  test('unknown or deleted capture: null', () => {
    const db = openTestDb()
    expect(loadCaptureDetail(db, 'nope', T0, TZ)).toBeNull()
    const b = seedBullet(db, T0, { state: 'deleted' })
    expect(loadCaptureDetail(db, b, T0, TZ)).toBeNull()
  })

  test('recording and both transcripts come along', () => {
    const db = openTestDb()
    const b = seedBullet(db, T0, { source: 'voice', text: 'server words' })
    const a = seedAudio(db, b, { local_path: 'file:///rec.m4a' })
    seedTranscript(db, b, a, 'device_draft', 'draft words')
    seedTranscript(db, b, a, 'server', 'server words')
    const d = loadCaptureDetail(db, b, T0, TZ)
    expect(d?.audio).toMatchObject({ id: a, local_path: 'file:///rec.m4a' })
    const v = transcriptView(d!)
    expect(v.tabs.map((t) => t.label)).toEqual(['Home transcript', 'Phone draft'])
    expect(v.initial).toBe('server')
    expect([v.text('server'), v.text('draft')]).toEqual(['server words', 'draft words'])
    expect(v.note).toBeNull()
    expect(d?.audioReadError).toBe(false)
  })

  test('a recording that cannot be transcribed asks, until kept as audio; others keep Retry', () => {
    const db = openTestDb()
    const b = seedBullet(db, T0, {
      source: 'voice',
      server_status: 'failed',
      server_error_code: 'transcription_failed',
    })
    expect(loadCaptureDetail(db, b, T0, TZ)).toMatchObject({
      transcriptionFailure: 'ask',
      errorReason: null,
    })
    keepAsAudioLocal(db, b)
    expect(loadCaptureDetail(db, b, T0, TZ)?.transcriptionFailure).toBe('kept')

    const silent = seedBullet(db, T0, {
      source: 'voice',
      server_status: 'failed',
      server_error_code: 'transcription_no_speech',
    })
    expect(loadCaptureDetail(db, silent, T0, TZ)).toMatchObject({
      transcriptionFailure: 'ask',
      errorReason: null,
      errorCode: 'transcription_no_speech',
    })

    const other = seedBullet(db, T0, {
      source: 'voice',
      server_status: 'failed',
      server_error_code: 'transcription_timeout',
    })
    expect(loadCaptureDetail(db, other, T0, TZ)).toMatchObject({
      transcriptionFailure: null,
      errorReason: 'Transcribing took too long.',
    })
  })

  test('"Write it down" starts from the phone draft, never the placeholder', () => {
    expect(
      writeDownStart({
        text: 'Voice note, 0:12',
        transcripts: [{ kind: 'device_draft', text: ' book the vet ' }],
      }),
    ).toBe('book the vet')
    expect(writeDownStart({ text: 'Voice note, 0:12', transcripts: [] })).toBe('')
    expect(writeDownStart({ text: 'water the plants', transcripts: [] })).toBe('water the plants')
  })

  test('a recording this phone could not read is flagged', () => {
    const db = openTestDb()
    const b = seedBullet(db, T0, { source: 'voice' })
    const a = seedAudio(db, b, { upload_status: 'pending' })
    setState(db, audioReadErrorKey(a), 'file missing')
    expect(loadCaptureDetail(db, b, T0, TZ)?.audioReadError).toBe(true)
  })
})

describe('Retry transcription', () => {
  test('offered on a finished capture read from the phone draft, not otherwise', () => {
    const db = openTestDb()
    const fromDraft = seedBullet(db, T0, {
      source: 'voice',
      server_status: 'needs_review',
      text_from_draft: true,
    })
    expect(loadCaptureDetail(db, fromDraft, T0, TZ)).toMatchObject({
      textFromDraft: true,
      retryTranscription: true,
    })
    const busy = seedBullet(db, T0, {
      source: 'voice',
      server_status: 'processing',
      text_from_draft: true,
    })
    expect(loadCaptureDetail(db, busy, T0, TZ)?.retryTranscription).toBe(false)
    const transcribed = seedBullet(db, T0, { source: 'voice', server_status: 'processed' })
    expect(loadCaptureDetail(db, transcribed, T0, TZ)?.retryTranscription).toBe(false)
  })
})

describe('transcript toggle', () => {
  const ts = [
    { kind: 'device_draft' as const, text: 'draft' },
    { kind: 'server' as const, text: 'home' },
  ]
  test('typed capture: no tabs, its text', () => {
    const v = transcriptView({
      text: 'typed',
      source: 'text',
      textEditedByUser: false,
      transcripts: [],
    })
    expect(v.tabs).toEqual([])
    expect(v.text(v.initial)).toBe('typed')
  })
  test('voice note before the home transcript: the draft, with the draft note', () => {
    const v = transcriptView({
      text: 'draft',
      source: 'voice',
      textEditedByUser: false,
      transcripts: [ts[0]!],
    })
    expect(v.tabs).toEqual([])
    expect(v.text(v.initial)).toBe('draft')
    expect(v.note).toMatch(/Live draft/)
  })
  test('no usable home transcript: labelled as the phone draft', () => {
    const v = transcriptView({
      text: 'remind me to buy olive oil tomorrow',
      source: 'voice',
      textEditedByUser: false,
      textFromDraft: true,
      transcripts: [ts[0]!],
    })
    expect(v.note).toBe("From the phone's live draft")
  })
  test('edited by the user: their text first, both transcripts still there', () => {
    const v = transcriptView({
      text: 'mine',
      source: 'voice',
      textEditedByUser: true,
      transcripts: ts,
    })
    expect(v.tabs.map((t) => t.id)).toEqual(['edit', 'server', 'draft'])
    expect(v.text(v.initial)).toBe('mine')
    expect(v.note).toMatch(/your words are kept/)
  })
})

describe('audio source', () => {
  const server = { baseUrl: 'http://home.example:3001/', token: 'tok' }
  const a = { id: 'a1', local_path: 'file:///r.m4a', upload_status: 'uploaded' as const }
  test('the local file first', () => {
    expect(audioSource(a, { localExists: () => true, server })).toEqual({
      kind: 'local',
      uri: 'file:///r.m4a',
    })
  })
  test('a path stored relative to Documents is resolved before it is played', () => {
    const rel = { ...a, local_path: 'recordings/r.wav' }
    const resolveLocal = (p: string) => `file:///Documents/${p}`
    expect(
      audioSource(rel, { localExists: (p) => p.startsWith('file:'), server, resolveLocal }),
    ).toEqual({ kind: 'local', uri: 'file:///Documents/recordings/r.wav' })
  })
  test('else streamed from the home server with the device token', () => {
    expect(audioSource(a, { localExists: () => false, server })).toEqual({
      kind: 'remote',
      uri: 'http://home.example:3001/sync/audio/a1',
      headers: { authorization: 'Bearer tok' },
    })
  })
  test('not uploaded yet, or no server: unavailable with a reason', () => {
    expect(
      audioSource(
        { ...a, local_path: null, upload_status: 'pending' },
        { localExists: () => false, server },
      ),
    ).toMatchObject({ kind: 'unavailable' })
    expect(
      audioSource({ ...a, local_path: null }, { localExists: () => false, server: null }),
    ).toMatchObject({
      kind: 'unavailable',
    })
  })
})

describe('edit and delete', () => {
  test('an edit saves only real, non-empty changes', () => {
    expect(editableText('ran 5k', ' ran 6k ')).toBe('ran 6k')
    expect(editableText('ran 5k', 'ran 5k ')).toBeNull()
    expect(editableText('ran 5k', '  ')).toBeNull()
  })
  test('two delete choices besides Cancel, in the contract modes', () => {
    expect(deleteChoices(2).map((c) => c.mode)).toEqual(['cascade', 'keep_extractions'])
  })
  test('every kind can be picked', () => {
    expect(THOUGHT_KINDS).toHaveLength(9)
  })
})
