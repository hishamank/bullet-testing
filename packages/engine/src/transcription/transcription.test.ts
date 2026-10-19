import { expect, test } from 'vite-plus/test'
import { createScriptedTranscriber, withTranscriberTimeout } from './scripted'
import { hasSpeech } from './speech'

const req = { audio: new Uint8Array([1, 2, 3]), mimeType: 'audio/mp4' }

test('scripted transcriber records calls and fills defaults', async () => {
  const t = createScriptedTranscriber(() => ({ text: 'yalla call mom', languages: ['ar', 'en'] }))
  expect(await t.transcribe(req)).toEqual({
    text: 'yalla call mom',
    engine: 'scripted',
    model: null,
    languages: ['ar', 'en'],
  })
  expect(t.calls).toHaveLength(1)
})

test('deadline → TRANSCRIBER_TIMEOUT', async () => {
  const hung = { transcribe: () => new Promise<never>(() => {}) }
  await expect(withTranscriberTimeout(hung, 10).transcribe(req)).rejects.toMatchObject({
    code: 'TRANSCRIBER_TIMEOUT',
  })
})

test('an empty transcript is a failure, not an empty bullet', async () => {
  const t = withTranscriberTimeout(
    createScriptedTranscriber(() => ({ text: '  ' })),
    1000,
  )
  await expect(t.transcribe(req)).rejects.toMatchObject({ code: 'TRANSCRIPTION_FAILED' })
})

test('a transcript with no words (a tone, blank audio) is a failure too', async () => {
  // Real whisper-server (large-v3-turbo) answers: a 440 Hz tone gives " .", blank audio a marker.
  for (const text of [' .', '[BLANK_AUDIO]', ' (silence) ...']) {
    const t = withTranscriberTimeout(
      createScriptedTranscriber(() => ({ text })),
      1000,
    )
    await expect(t.transcribe(req)).rejects.toMatchObject({ code: 'TRANSCRIPTION_FAILED' })
  }
  expect(hasSpeech('ok')).toBe(true)
  expect(hasSpeech('٣ بكرا')).toBe(true)
  expect(hasSpeech('bukra [inaudible] el report')).toBe(true)
})
