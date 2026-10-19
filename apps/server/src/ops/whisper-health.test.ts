import { createScriptedTranscriber, EngineError } from '@bullet/engine'
import { expect, test } from 'vite-plus/test'
import { ffmpegAvailable, watchConversionFailures } from './whisper-health'

let n = 0
/** A different recording each call, unless `same` repeats the previous one. */
const req = (same = false) => ({
  audio: new Uint8Array([same ? n : ++n]),
  mimeType: 'audio/wav',
  languageHints: [],
})

test('ffmpegAvailable reads the exit status and spawn errors', () => {
  expect(ffmpegAvailable(() => ({ status: 0 }))).toBe(true)
  expect(ffmpegAvailable(() => ({ status: 1 }))).toBe(false)
  expect(ffmpegAvailable(() => ({ status: null, error: new Error('ENOENT') }))).toBe(false)
})

test('several conversion failures in a row warn; a success resets the streak', async () => {
  const outcomes: ('ok' | 'convert' | 'other')[] = []
  const inner = createScriptedTranscriber(() => {
    const o = outcomes.shift()
    if (o === 'convert') {
      throw new EngineError('TRANSCRIPTION_FAILED', 'could not decode (ffmpeg conversion failed)')
    }
    if (o === 'other') throw new EngineError('TRANSCRIBER_HTTP', 'down')
    return { text: 'hello' }
  })
  const warnings: string[] = []
  const t = watchConversionFailures(inner, { threshold: 3, warn: (m) => warnings.push(m) })
  const run = async (o: (typeof outcomes)[number], same = false) => {
    outcomes.push(o)
    await t.transcribe(req(same)).catch(() => undefined)
  }

  await run('convert')
  await run('convert')
  await run('ok') // resets
  await run('convert')
  await run('convert', true) // a retry of the same recording counts once
  await run('other', true) // not a conversion failure: neither counts nor resets
  await run('convert')
  expect(warnings).toEqual([])
  await run('convert')
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('3 recordings in a row')
})
