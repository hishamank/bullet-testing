import { describe, expect, test, vi } from 'vite-plus/test'
import { createWhisperCppTranscriber, whisperLanguageCode } from './whisper-cpp'

const req = { audio: new Uint8Array([1, 2, 3]), mimeType: 'audio/mp4', languageHints: ['en', 'ar'] }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('createWhisperCppTranscriber', () => {
  test('posts multipart to /inference with language=auto and verbose_json', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ task: 'transcribe', language: 'arabic', text: ' yalla call\n mom \n' }),
    )
    const t = createWhisperCppTranscriber({
      baseUrl: 'http://home.local:8081/',
      model: 'large-v3-turbo-q5_0',
      prompt: 'Mixed English, Lebanese Arabic and French.',
      fetch: fetchMock as unknown as typeof fetch,
    })

    expect(await t.transcribe(req)).toEqual({
      text: 'yalla call mom',
      engine: 'whisper.cpp',
      model: 'large-v3-turbo-q5_0',
      languages: ['ar'],
    })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://home.local:8081/inference')
    const form = init.body as FormData
    expect(form.get('language')).toBe('auto')
    expect(form.get('response_format')).toBe('verbose_json')
    expect(form.get('temperature')).toBe('0')
    expect(form.get('prompt')).toBe('Mixed English, Lebanese Arabic and French.')
    const file = form.get('file') as File
    expect(file.name).toBe('audio.m4a')
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(req.audio)
  })

  test('defaults the model name and leaves unknown languages out', async () => {
    const t = createWhisperCppTranscriber({
      baseUrl: 'http://x',
      fetch: (async () => jsonResponse({ language: 'klingon', text: 'hi' })) as typeof fetch,
    })
    expect(await t.transcribe(req)).toMatchObject({ model: 'large-v3-turbo', languages: [] })
  })

  test('a 400 (unreadable audio) → TRANSCRIPTION_FAILED', async () => {
    const t = createWhisperCppTranscriber({
      baseUrl: 'http://x',
      fetch: (async () =>
        jsonResponse({ error: 'failed to read audio data' }, 400)) as typeof fetch,
    })
    await expect(t.transcribe(req)).rejects.toMatchObject({ code: 'TRANSCRIPTION_FAILED' })
  })

  test('a 5xx or a network failure → TRANSCRIBER_HTTP', async () => {
    const down = createWhisperCppTranscriber({
      baseUrl: 'http://x',
      fetch: (async () => new Response('busy', { status: 503 })) as typeof fetch,
    })
    await expect(down.transcribe(req)).rejects.toMatchObject({ code: 'TRANSCRIBER_HTTP' })

    const unreachable = createWhisperCppTranscriber({
      baseUrl: 'http://x',
      fetch: (async () => {
        throw new TypeError('fetch failed')
      }) as typeof fetch,
    })
    await expect(unreachable.transcribe(req)).rejects.toMatchObject({ code: 'TRANSCRIBER_HTTP' })
  })

  test('an abort → TRANSCRIBER_TIMEOUT', async () => {
    const t = createWhisperCppTranscriber({
      baseUrl: 'http://x',
      fetch: (async () => {
        throw new DOMException('timed out', 'TimeoutError')
      }) as typeof fetch,
    })
    await expect(t.transcribe(req)).rejects.toMatchObject({ code: 'TRANSCRIBER_TIMEOUT' })
  })
})

test('whisperLanguageCode maps whisper.cpp names to ISO codes', () => {
  expect(whisperLanguageCode('Arabic')).toBe('ar')
  expect(whisperLanguageCode('french')).toBe('fr')
  expect(whisperLanguageCode('en')).toBe('en')
  expect(whisperLanguageCode('klingon')).toBeNull()
})
