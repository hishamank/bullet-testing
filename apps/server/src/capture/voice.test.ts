import { createHash } from 'node:crypto'
import { pullResponseSchema } from '@bullet/core'
import { createScriptedTranscriber, EngineError } from '@bullet/engine'
import { eq } from 'drizzle-orm'
import { describe, expect, test } from 'vite-plus/test'
import { audioAttachments, bullets, jobs, transcripts } from '../db/schema'
import { DEFAULT_RETRY_POLICY } from '../queue/jobs'
import { candidate, createHarness, llmByText, T0, uid } from '../test/helpers'

const AUDIO = new Uint8Array(Array.from({ length: 10 }, (_, i) => i + 1))
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

type H = ReturnType<typeof createHarness>

/** Push a voice capture with its recording metadata + device draft. */
async function captureVoice(
  h: H,
  opts: { edited?: boolean; text?: string; sha?: string | null } = {},
) {
  const bulletId = uid()
  const audioId = uid()
  const draft = 'call mom bukra'
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
          duration_ms: 3_000,
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

  test('an empty transcript fails as transcription_failed', async () => {
    const h = createHarness(llmByText({}), {
      transcriber: createScriptedTranscriber(() => ({ text: '' })),
    })
    const { bulletId, audioId } = await captureVoice(h)
    await put(h, audioId, 0, AUDIO)
    await h.worker.drain()
    expect(bullet(h, bulletId)?.proc_error_code).toBe('transcription_failed')
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
