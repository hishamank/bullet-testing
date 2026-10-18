import { expect, test } from 'vite-plus/test'
import { createScriptedTranscriber, withTranscriberTimeout } from './scripted'

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
