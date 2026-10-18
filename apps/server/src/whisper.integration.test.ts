/**
 * Opt-in: runs against a live whisper-server. Skipped unless both are set, e.g.
 *   WHISPER_TEST_URL=http://127.0.0.1:8081 WHISPER_TEST_AUDIO=~/src/whisper.cpp/samples/jfk.mp3
 */

import { readFileSync } from 'node:fs'
import { createWhisperCppTranscriber, withTranscriberTimeout } from '@bullet/engine'
import { expect, test } from 'vite-plus/test'

const url = process.env.WHISPER_TEST_URL
const audioPath = process.env.WHISPER_TEST_AUDIO

test.skipIf(!url || !audioPath)(
  'transcribes a real recording via whisper-server',
  async () => {
    const t = withTranscriberTimeout(createWhisperCppTranscriber({ baseUrl: url! }), 120_000)
    const ext = audioPath!.split('.').pop()!.toLowerCase()
    const mimeType = ext === 'wav' ? 'audio/wav' : ext === 'mp3' ? 'audio/mpeg' : 'audio/mp4'
    const res = await t.transcribe({ audio: readFileSync(audioPath!), mimeType })
    expect(res.engine).toBe('whisper.cpp')
    expect(res.text.length).toBeGreaterThan(0)
    expect(res.languages).toHaveLength(1)
  },
  130_000,
)
