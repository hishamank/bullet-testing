import { createHash } from 'node:crypto'
import { pullResponseSchema } from '@bullet/core'
import {
  createScriptedLlmClient,
  createScriptedTranscriber,
  ENGINE_CONFIG_DEFAULTS,
  EngineError,
} from '@bullet/engine'
import { eq } from 'drizzle-orm'
import { describe, expect, test } from 'vite-plus/test'
import { audioAttachments, bullets, jobs, transcripts } from '../db/schema'
import { claimNextJob, DEFAULT_RETRY_POLICY } from '../queue/jobs'
import { processClaimedJob } from '../queue/process'
import { parseByteRange } from './audio'
import { candidate, createHarness, llmByText, T0, uid } from '../test/helpers'

const AUDIO = new Uint8Array(Array.from({ length: 10 }, (_, i) => i + 1))
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

type H = ReturnType<typeof createHarness>

/** Push a voice capture with its recording metadata + device draft. */
async function captureVoice(
  h: H,
  opts: {
    edited?: boolean
    text?: string
    sha?: string | null
    draft?: string
    durationMs?: number
  } = {},
) {
  const bulletId = uid()
  const audioId = uid()
  const draft = opts.draft ?? 'call mom bukra'
  const res = await h.push([
    {
      op_id: uid(),
      type: 'bullet.create',
      bullet: {
        id: bulletId,
        text: opts.text ?? draft,
        captured_at: T0,
        timezone: 'Europe/Paris',
        source: 'voice',
        text_edited_by_user: opts.edited ?? false,
        audio: {
          id: audioId,
          mime_type: 'audio/mp4',
          duration_ms: opts.durationMs ?? 3_000,
          size_bytes: AUDIO.length,
          sha256: opts.sha === undefined ? sha(AUDIO) : opts.sha,
          draft: { text: draft, engine: 'apple-speechanalyzer', model: null, languages: ['en-US'] },
        },
      },
    },
  ])
  expect(res.results[0]?.status).toBe('applied')
  return { bulletId, audioId }
}

const auth = (h: H) => ({ authorization: `Bearer ${h.token}` })

const put = (h: H, id: string, offset: number, bytes: Uint8Array) =>
  h.request(`/sync/audio/${id}`, {
    method: 'PUT',
    headers: {
      ...auth(h),
      'content-type': 'application/octet-stream',
      'upload-offset': String(offset),
    },
    body: new Uint8Array(bytes),
  })

const bullet = (h: H, id: string) => h.db.select().from(bullets).where(eq(bullets.id, id)).get()

const whisper = (text = 'call mom tomorrow, yalla') =>
  createScriptedTranscriber(() => ({
    text,
    engine: 'whisper.cpp',
    model: 'large-v3-turbo',
    languages: ['en', 'ar'],
  }))

describe('voice notes: upload', () => {
  test('a voice bullet waits in synced until its recording has fully arrived', async () => {
    const t = whisper()
    const h = createHarness(llmByText({}), { transcriber: t })
    const { bulletId, audioId } = await captureVoice(h)
    expect(h.db.select().from(jobs).get()?.status).toBe('waiting_audio')
    expect(await h.worker.drain()).toBe(0)
    expect(bullet(h, bulletId)?.proc_status).toBe('synced')

    expect((await put(h, audioId, 0, AUDIO.slice(0, 4))).status).toBe(200)
    expect(await h.worker.drain()).toBe(0)
    const done = await put(h, audioId, 4, AUDIO.slice(4))
    expect(await done.json()).toEqual({
      attachment_id: audioId,
      size_bytes: AUDIO.length,
      received_bytes: AUDIO.length,
      upload_status: 'uploaded',
    })
    expect(await h.worker.drain()).toBe(1)
    expect(h.audioStore.files.get(audioId)).toEqual(AUDIO)
  })

  test('resumable: a wrong offset is 409; the status says where to continue', async () => {
    const h = createHarness()
    const { audioId } = await captureVoice(h)
    await put(h, audioId, 0, AUDIO.slice(0, 3))
    expect((await put(h, audioId, 0, AUDIO.slice(0, 3))).status).toBe(409)
    const status = await h.request(`/sync/audio/${audioId}/status`, { headers: auth(h) })
    expect(await status.json()).toMatchObject({ received_bytes: 3, upload_status: 'pending' })
  })

  test('idempotent: re-sending a finished upload changes nothing', async () => {
    const h = createHarness()
    const { audioId } = await captureVoice(h)
    await put(h, audioId, 0, AUDIO)
    const again = await put(h, audioId, 0, AUDIO)
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ upload_status: 'uploaded' })
  })

  test('a checksum mismatch is 422 and restarts the upload', async () => {
    const h = createHarness()
    const { audioId } = await captureVoice(h, { sha: 'f'.repeat(64) })
    const res = await put(h, audioId, 0, AUDIO)
    expect(res.status).toBe(422)
    const row = h.db.select().from(audioAttachments).get()
    expect(row).toMatchObject({ received_bytes: 0, upload_status: 'pending' })
  })

  test('unknown recording → 404; oversize → 400; download after upload', async () => {
    const h = createHarness()
    expect((await put(h, uid(), 0, AUDIO)).status).toBe(404)
    const { audioId } = await captureVoice(h)
    expect((await put(h, audioId, 0, new Uint8Array(AUDIO.length + 1))).status).toBe(400)
    await put(h, audioId, 0, AUDIO)
    const dl = await h.request(`/sync/audio/${audioId}`, { headers: auth(h) })
    expect(dl.headers.get('content-type')).toBe('audio/mp4')
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(AUDIO)
  })
})

describe('voice notes: ranged download (seeking)', () => {
  test('parses single byte ranges', () => {
    expect(parseByteRange(undefined, 10)).toBeNull()
    expect(parseByteRange('bytes=2-5', 10)).toEqual({ start: 2, end: 5 })
    expect(parseByteRange('bytes=4-', 10)).toEqual({ start: 4, end: 9 })
    expect(parseByteRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 })
    expect(parseByteRange('bytes=8-99', 10)).toEqual({ start: 8, end: 9 })
    expect(parseByteRange('bytes=10-', 10)).toBe('unsatisfiable')
    expect(parseByteRange('bytes=5-2', 10)).toBeNull()
    expect(parseByteRange('bytes=0-1,4-5', 10)).toBeNull()
    expect(parseByteRange('items=0-1', 10)).toBeNull()
  })

  test('206 with the asked bytes, 416 past the end, 200 + Accept-Ranges otherwise', async () => {
    const h = createHarness()
    const { audioId } = await captureVoice(h)
    await put(h, audioId, 0, AUDIO)
    const get = (range?: string) =>
      h.request(`/sync/audio/${audioId}`, { headers: { ...auth(h), ...(range ? { range } : {}) } })

    const whole = await get()
    expect(whole.status).toBe(200)
    expect(whole.headers.get('accept-ranges')).toBe('bytes')
    expect(whole.headers.get('content-length')).toBe(String(AUDIO.length))

    const part = await get('bytes=2-4')
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe(`bytes 2-4/${AUDIO.length}`)
    expect(part.headers.get('content-length')).toBe('3')
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(AUDIO.slice(2, 5))

    const past = await get(`bytes=${AUDIO.length}-`)
    expect(past.status).toBe(416)
    expect(past.headers.get('content-range')).toBe(`bytes */${AUDIO.length}`)
  })
})

describe('voice notes: transcription', () => {
  test('synced → transcribing → processing: the server transcript replaces the draft', async () => {
    const t = whisper()
    const llm = llmByText({
      'call mom tomorrow': [
        candidate({
          kind: 'task',
          orientation: 'future_oneoff',
          fields: { title: 'call mom', when: 'tomorrow' },
        }),
      ],
    })
    const h = createHarness(llm, { transcriber: t })
    const { bulletId, audioId } = await captureVoice(h)
    await put(h, audioId, 0, AUDIO)
    await h.worker.drain()

    expect(t.calls[0]).toMatchObject({ mimeType: 'audio/mp4', languageHints: ['en', 'ar', 'fr'] })
    expect(t.calls[0]?.audio).toEqual(AUDIO)
    expect(bullet(h, bulletId)).toMatchObject({
      text: 'call mom tomorrow, yalla',
      proc_status: 'needs_review',
    })

    const pulled = pullResponseSchema.parse(await h.pull())
    expect(
      pulled.changes.transcripts
        .map((x) => [x.kind, x.engine])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ['device_draft', 'apple-speechanalyzer'],
      ['server', 'whisper.cpp'],
    ])
    expect(pulled.changes.transcripts.find((x) => x.kind === 'server')).toMatchObject({
      model: 'large-v3-turbo',
      languages: ['en', 'ar'],
      attachment_id: audioId,
    })
    expect(pulled.changes.audio_attachments[0]).toMatchObject({
      id: audioId,
      upload_status: 'uploaded',
    })
    expect(pulled.changes.bullets[0]?.text).toBe('call mom tomorrow, yalla')
  })

  test('if the user edited the draft, their text wins; the transcript is only stored', async () => {
    const t = whisper()
    const llm = llmByText({})
    const h = createHarness(llm, { transcriber: t })
    const { bulletId, audioId } = await captureVoice(h, {
      edited: true,
      text: 'call Mom (about Paris)',
    })
    await put(h, audioId, 0, AUDIO)
    await h.worker.drain()
    expect(bullet(h, bulletId)?.text).toBe('call Mom (about Paris)')
    expect(h.db.select().from(transcripts).where(eq(transcripts.kind, 'server')).get()?.text).toBe(
      'call mom tomorrow, yalla',
    )
    // Extraction ran on the user's text.
    expect(llm.chatCalls[0]?.messages[1]?.content).toContain('call Mom (about Paris)')
  })

  test('a later edit also protects the text from a transcript', async () => {
    const h = createHarness(llmByText({}), { transcriber: whisper() })
    const { bulletId, audioId } = await captureVoice(h)
    await h.push([
      {
        op_id: uid(),
        type: 'bullet.edit',
        bullet_id: bulletId,
        text: 'my words',
        edited_at: T0 + 1,
      },
    ])
    await put(h, audioId, 0, AUDIO)
    await h.worker.drain()
    expect(bullet(h, bulletId)).toMatchObject({ text: 'my words', text_edited_by_user: true })
  })

  test('transcription failure: retried with backoff, then failed with its own code; retry works', async () => {
    let up = false
    const t = createScriptedTranscriber(() => {
      if (!up) throw new EngineError('TRANSCRIBER_HTTP', 'whisper down')
      return { text: 'hello' }
    })
    const h = createHarness(llmByText({}), { transcriber: t })
    const { bulletId, audioId } = await captureVoice(h)
    await put(h, audioId, 0, AUDIO)
    await h.worker.drain()
    expect(bullet(h, bulletId)).toMatchObject({
      proc_status: 'synced',
      proc_error_code: 'transcription_unavailable',
    })
    for (let i = 1; i < DEFAULT_RETRY_POLICY.maxAttempts; i++) {
      h.clock.now += DEFAULT_RETRY_POLICY.maxDelayMs
      await h.worker.drain()
    }
    expect(bullet(h, bulletId)).toMatchObject({
      proc_status: 'failed',
      proc_error_code: 'transcription_unavailable',
    })

    up = true
    await h.push([{ op_id: uid(), type: 'bullet.retry', bullet_id: bulletId }])
    await h.worker.drain()
    expect(bullet(h, bulletId)).toMatchObject({ proc_status: 'processed', text: 'hello' })
  })

  test('the transcribing state is visible while Whisper runs', async () => {
    let seen: string | undefined
    const h0: { h?: H } = {}
    const t = createScriptedTranscriber(() => {
      seen = h0.h?.db.select().from(bullets).get()?.proc_status
      return { text: 'x' }
    })
    const h = createHarness(llmByText({}), { transcriber: t })
    h0.h = h
    const { audioId } = await captureVoice(h)
    await put(h, audioId, 0, AUDIO)
    await h.worker.drain()
    expect(seen).toBe('transcribing')
  })

  test('an empty transcript fails at once as transcription_no_speech (no retries)', async () => {
    let calls = 0
    const h = createHarness(llmByText({}), {
      transcriber: createScriptedTranscriber(() => {
        calls += 1
        return { text: '' }
      }),
    })
    const { bulletId, audioId } = await captureVoice(h)
    await put(h, audioId, 0, AUDIO)
    await h.worker.drain()
    expect(bullet(h, bulletId)).toMatchObject({
      proc_status: 'failed',
      proc_error_code: 'transcription_no_speech',
      proc_attempts: 1,
      proc_next_retry_at: null,
    })
    h.clock.now += DEFAULT_RETRY_POLICY.maxDelayMs
    await h.worker.drain()
    expect(calls).toBe(1)
  })

  test('a transcript with no words (" ." for a tone) never replaces the draft', async () => {
    const h = createHarness(llmByText({}), {
      transcriber: createScriptedTranscriber(() => ({ text: ' .' })),
    })
    const { bulletId, audioId } = await captureVoice(h)
    await put(h, audioId, 0, AUDIO)
    await h.worker.drain()
    expect(bullet(h, bulletId)?.proc_error_code).toBe('transcription_no_speech')
    expect(bullet(h, bulletId)?.text).toBe('call mom bukra')
  })

  test('a corrupt recording fails at once as transcription_failed', async () => {
    const h = createHarness(llmByText({}), {
      transcriber: createScriptedTranscriber(() => {
        throw new EngineError('TRANSCRIPTION_FAILED', 'ffmpeg conversion failed')
      }),
    })
    const { bulletId, audioId } = await captureVoice(h)
    await put(h, audioId, 0, AUDIO)
    await h.worker.drain()
    expect(bullet(h, bulletId)).toMatchObject({
      proc_status: 'failed',
      proc_error_code: 'transcription_failed',
      proc_attempts: 1,
    })
    expect(h.db.select().from(jobs).get()?.status).toBe('failed')
  })

  test('a zero-length recording is no speech, without calling the transcriber', async () => {
    const t = whisper()
    const h = createHarness(llmByText({}), { transcriber: t })
    const { bulletId, audioId } = await captureVoice(h, { durationMs: 0 })
    await put(h, audioId, 0, AUDIO)
    await h.worker.drain()
    expect(t.calls).toHaveLength(0)
    expect(bullet(h, bulletId)).toMatchObject({
      proc_status: 'failed',
      proc_error_code: 'transcription_no_speech',
    })
  })

  test('a transcriber that is down keeps the normal retry schedule', async () => {
    const h = createHarness(llmByText({}), {
      transcriber: createScriptedTranscriber(() => {
        throw new EngineError('TRANSCRIBER_HTTP', 'unreachable')
      }),
    })
    const { bulletId, audioId } = await captureVoice(h)
    await put(h, audioId, 0, AUDIO)
    await h.worker.drain()
    expect(bullet(h, bulletId)).toMatchObject({
      proc_status: 'synced',
      proc_error_code: 'transcription_unavailable',
    })
    expect(bullet(h, bulletId)?.proc_next_retry_at).not.toBeNull()
  })

  for (const [code, err] of [
    ['transcription_failed', 'TRANSCRIPTION_FAILED'],
    ['transcription_no_speech', 'TRANSCRIPTION_NO_SPEECH'],
  ] as const) {
    test(`an untranscribable recording (${code}) the user wrote down is read from their text`, async () => {
      const llm = llmByText({})
      const h = createHarness(llm, {
        transcriber: createScriptedTranscriber(() => {
          throw new EngineError(err, 'cannot transcribe')
        }),
      })
      const { bulletId, audioId } = await captureVoice(h)
      await put(h, audioId, 0, AUDIO)
      await h.worker.drain()
      expect(bullet(h, bulletId)).toMatchObject({ proc_status: 'failed', proc_error_code: code })

      // "Write it down": a user edit, then normal processing on their words, at once.
      await h.push([
        {
          op_id: uid(),
          type: 'bullet.edit',
          bullet_id: bulletId,
          text: 'call the plumber about the sink',
          edited_at: h.clock.now,
        },
      ])
      await h.worker.drain()
      expect(bullet(h, bulletId)).toMatchObject({
        proc_status: 'processed',
        text: 'call the plumber about the sink',
        text_edited_by_user: true,
      })
      expect(llm.chatCalls.at(-1)?.messages[1]?.content).toContain(
        'call the plumber about the sink',
      )
      expect(h.db.select().from(transcripts).where(eq(transcripts.kind, 'server')).all()).toEqual(
        [],
      )
    })
  }

  test('a user-edited bullet whose transcription is briefly down keeps the transcript once it works', async () => {
    let calls = 0
    const h = createHarness(llmByText({}), {
      transcriber: createScriptedTranscriber(() => {
        calls += 1
        if (calls === 1) throw new EngineError('TRANSCRIBER_HTTP', 'whisper busy')
        return { text: 'call mom tomorrow' }
      }),
    })
    const { bulletId, audioId } = await captureVoice(h, { edited: true, text: 'call Mom' })
    await put(h, audioId, 0, AUDIO)
    await h.worker.drain()
    expect(bullet(h, bulletId)?.proc_status).toBe('synced')
    h.clock.now += DEFAULT_RETRY_POLICY.maxDelayMs
    await h.worker.drain()
    expect(bullet(h, bulletId)).toMatchObject({ proc_status: 'processed', text: 'call Mom' })
    expect(h.db.select().from(transcripts).where(eq(transcripts.kind, 'server')).get()?.text).toBe(
      'call mom tomorrow',
    )
  })

  test('the transcription stage itself refuses a transcript with no words', async () => {
    // Called directly, without the worker's transcriber wrapper: no transcriber bypasses it.
    const h = createHarness()
    const { bulletId, audioId } = await captureVoice(h)
    await put(h, audioId, 0, AUDIO)
    const claimed = claimNextJob(h.db, h.clock.now, { canTranscribe: true })
    expect(claimed?.transcribe).not.toBeNull()
    const deps = {
      db: h.db,
      llm: createScriptedLlmClient({ chat: () => '{"candidates":[]}' }),
      engine: ENGINE_CONFIG_DEFAULTS,
      now: () => h.clock.now,
      transcriber: createScriptedTranscriber(() => ({ text: '[BLANK_AUDIO]' })),
      audioStore: h.audioStore,
    }
    await expect(processClaimedJob(deps, claimed!)).rejects.toMatchObject({
      code: 'TRANSCRIPTION_NO_SPEECH',
    })
    expect(bullet(h, bulletId)?.text).toBe('call mom bukra')
  })

  test('a retry after extraction failed does not transcribe again', async () => {
    let llmUp = false
    const llm = {
      chat: async () => {
        if (!llmUp) throw new EngineError('LLM_HTTP', 'down')
        return { message: { role: 'assistant' as const, content: '{"candidates":[]}' }, raw: {} }
      },
    }
    const t = whisper()
    const h = createHarness(llm, { transcriber: t })
    const { bulletId, audioId } = await captureVoice(h)
    await put(h, audioId, 0, AUDIO)
    await h.worker.drain()
    expect(bullet(h, bulletId)?.proc_error_code).toBe('llm_unavailable')
    llmUp = true
    h.clock.now += DEFAULT_RETRY_POLICY.maxDelayMs
    await h.worker.drain()
    expect(t.calls).toHaveLength(1)
    expect(bullet(h, bulletId)?.proc_status).toBe('processed')
  })

  test('text bullets skip transcribing; without a transcriber, voice uses the device draft', async () => {
    const llm = llmByText({})
    const h = createHarness(llm) // no transcriber
    const { bulletId, audioId } = await captureVoice(h)
    await put(h, audioId, 0, AUDIO)
    await h.worker.drain()
    expect(bullet(h, bulletId)).toMatchObject({ proc_status: 'processed', text: 'call mom bukra' })
  })

  test('deleting a voice bullet soft-deletes its recording + transcripts (file kept)', async () => {
    const h = createHarness()
    const { bulletId, audioId } = await captureVoice(h)
    await put(h, audioId, 0, AUDIO)
    await h.push([
      { op_id: uid(), type: 'bullet.delete', bullet_id: bulletId, mode: 'keep_extractions' },
    ])
    expect(h.db.select().from(audioAttachments).get()?.state).toBe('deleted')
    expect(
      h.db
        .select()
        .from(transcripts)
        .all()
        .every((x) => x.state === 'deleted'),
    ).toBe(true)
    expect(h.audioStore.files.get(audioId)).toEqual(AUDIO)
  })

  test('replaying the voice create is a duplicate even after the transcript changed the text', async () => {
    const h = createHarness(llmByText({}), { transcriber: whisper() })
    const bulletId = uid()
    const op = {
      op_id: uid(),
      type: 'bullet.create' as const,
      bullet: {
        id: bulletId,
        text: 'draft',
        captured_at: T0,
        timezone: 'UTC',
        source: 'voice' as const,
        audio: {
          id: uid(),
          mime_type: 'audio/mp4',
          duration_ms: 1,
          size_bytes: AUDIO.length,
          sha256: null,
          draft: { text: 'draft', engine: 'apple', model: null, languages: [] },
        },
      },
    }
    await h.push([op])
    await put(h, op.bullet.audio.id, 0, AUDIO)
    await h.worker.drain()
    expect((await h.push([{ ...op, op_id: uid() }])).results[0]?.status).toBe('duplicate')
  })
})

describe('voice notes: the phone draft when no transcript is usable', () => {
  const DRAFT = 'remind me to buy olive oil tomorrow'

  for (const [what, transcriber] of [
    ['no speech', () => createScriptedTranscriber(() => ({ text: ' .' }))],
    [
      'corrupt audio',
      () =>
        createScriptedTranscriber(() => {
          throw new EngineError('TRANSCRIPTION_FAILED', 'ffmpeg conversion failed')
        }),
    ],
    ['a silence hallucination', () => createScriptedTranscriber(() => ({ text: ' Thank you.' }))],
  ] as const) {
    test(`${what} → the draft becomes the text, processed as usual`, async () => {
      const llm = llmByText({})
      const h = createHarness(llm, { transcriber: transcriber() })
      const { bulletId, audioId } = await captureVoice(h, { draft: DRAFT, text: DRAFT })
      await put(h, audioId, 0, AUDIO)
      await h.worker.drain()
      expect(bullet(h, bulletId)).toMatchObject({
        proc_status: 'processed',
        proc_error_code: null,
        text: DRAFT,
        text_from_draft: true,
        text_edited_by_user: false,
      })
      expect(llm.chatCalls.at(-1)?.messages[1]?.content).toContain(DRAFT)
      expect(h.db.select().from(transcripts).where(eq(transcripts.kind, 'server')).all()).toEqual(
        [],
      )
      // The flag reaches the phone.
      const pulled = pullResponseSchema.parse(
        await (await h.request('/sync/pull', { headers: auth(h) })).json(),
      )
      expect(pulled.changes.bullets.find((b) => b.id === bulletId)?.text_from_draft).toBe(true)
    })
  }

  test('a silence hallucination with too short a draft fails as no speech', async () => {
    const h = createHarness(llmByText({}), {
      transcriber: createScriptedTranscriber(() => ({ text: 'Thanks for watching!' })),
    })
    const { bulletId, audioId } = await captureVoice(h, { draft: 'Thank you.' })
    await put(h, audioId, 0, AUDIO)
    await h.worker.drain()
    expect(bullet(h, bulletId)).toMatchObject({
      proc_status: 'failed',
      proc_error_code: 'transcription_no_speech',
      text_from_draft: false,
    })
  })

  test('a long real transcript that says "thank you" is kept', async () => {
    const said = 'Thank you note for Sam, and pay the electricity bill.'
    const h = createHarness(llmByText({}), {
      transcriber: createScriptedTranscriber(() => ({ text: said })),
    })
    const { bulletId, audioId } = await captureVoice(h, { draft: '', text: 'Voice note, 0:03' })
    await put(h, audioId, 0, AUDIO)
    await h.worker.drain()
    expect(bullet(h, bulletId)).toMatchObject({ text: said, text_from_draft: false })
  })

  test('"Retry transcription": a good transcript replaces the draft text', async () => {
    let up = false
    const llm = llmByText({})
    const h = createHarness(llm, {
      transcriber: createScriptedTranscriber(() => ({
        text: up ? 'Remind me to buy olive oil tomorrow.' : '',
      })),
    })
    const { bulletId, audioId } = await captureVoice(h, { draft: DRAFT, text: DRAFT })
    await put(h, audioId, 0, AUDIO)
    await h.worker.drain()
    expect(bullet(h, bulletId)).toMatchObject({ proc_status: 'processed', text_from_draft: true })

    up = true
    await h.push([{ op_id: uid(), type: 'bullet.retry', bullet_id: bulletId }])
    expect(bullet(h, bulletId)?.proc_status).toBe('synced')
    await h.worker.drain()
    expect(bullet(h, bulletId)).toMatchObject({
      proc_status: 'processed',
      text: 'Remind me to buy olive oil tomorrow.',
      text_from_draft: false,
    })
    // Retry only re-runs a draft capture or a failed one.
    const calls = llm.chatCalls.length
    await h.push([{ op_id: uid(), type: 'bullet.retry', bullet_id: bulletId }])
    expect(bullet(h, bulletId)?.proc_status).toBe('processed')
    await h.worker.drain()
    expect(llm.chatCalls.length).toBe(calls)
  })

  test('"Retry transcription" that still finds no speech leaves the capture as it was', async () => {
    const llm = llmByText({})
    const t = createScriptedTranscriber(() => ({ text: '[BLANK_AUDIO]' }))
    const h = createHarness(llm, { transcriber: t })
    const { bulletId, audioId } = await captureVoice(h, { draft: DRAFT, text: DRAFT })
    await put(h, audioId, 0, AUDIO)
    await h.worker.drain()
    const calls = llm.chatCalls.length
    await h.push([{ op_id: uid(), type: 'bullet.retry', bullet_id: bulletId }])
    await h.worker.drain()
    expect(t.calls).toHaveLength(2)
    expect(llm.chatCalls.length).toBe(calls)
    expect(bullet(h, bulletId)).toMatchObject({
      proc_status: 'processed',
      proc_error_code: null,
      text: DRAFT,
      text_from_draft: true,
    })
  })

  test("editing a draft capture makes it the user's text; a transcript no longer replaces it", async () => {
    let up = false
    const h = createHarness(llmByText({}), {
      transcriber: createScriptedTranscriber(() => ({ text: up ? 'something else entirely' : '' })),
    })
    const { bulletId, audioId } = await captureVoice(h, { draft: DRAFT, text: DRAFT })
    await put(h, audioId, 0, AUDIO)
    await h.worker.drain()
    await h.push([
      {
        op_id: uid(),
        type: 'bullet.edit',
        bullet_id: bulletId,
        text: 'buy olive oil and bread tomorrow',
        edited_at: h.clock.now,
      },
    ])
    expect(bullet(h, bulletId)).toMatchObject({ text_from_draft: false, text_edited_by_user: true })
    up = true
    await h.worker.drain()
    expect(bullet(h, bulletId)).toMatchObject({
      proc_status: 'processed',
      text: 'buy olive oil and bread tomorrow',
    })
  })
})
