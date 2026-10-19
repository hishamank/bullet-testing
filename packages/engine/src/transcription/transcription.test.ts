import { describe, expect, test } from 'vite-plus/test'
import { createScriptedTranscriber, withTranscriberTimeout } from './scripted'
import {
  hasSpeech,
  isSilenceHallucination,
  isUsableDraft,
  transcriptIsNoSpeech,
  wordCount,
} from './speech'

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
  await expect(t.transcribe(req)).rejects.toMatchObject({ code: 'TRANSCRIPTION_NO_SPEECH' })
})

test('a transcript with no words (a tone, blank audio) is a failure too', async () => {
  // Real whisper-server (large-v3-turbo) answers: a 440 Hz tone gives " .", blank audio a marker.
  for (const text of [' .', '[BLANK_AUDIO]', ' (silence) ...']) {
    const t = withTranscriberTimeout(
      createScriptedTranscriber(() => ({ text })),
      1000,
    )
    await expect(t.transcribe(req)).rejects.toMatchObject({ code: 'TRANSCRIPTION_NO_SPEECH' })
  }
  expect(hasSpeech('ok')).toBe(true)
  expect(hasSpeech('٣ بكرا')).toBe(true)
  expect(hasSpeech('bukra [inaudible] el report')).toBe(true)
})

describe('silence hallucinations', () => {
  test('known phrases, alone or repeated, in English, French and Arabic', () => {
    for (const text of [
      ' Thank you.',
      'Thanks for watching!',
      'you',
      'Thank you. Thank you.',
      'Merci.',
      "Merci d'avoir regardé !",
      'شكرا.',
      'ترجمة نانسي قنقر',
    ]) {
      expect(isSilenceHallucination(text), text).toBe(true)
    }
  })

  test('a real sentence is never one, even with "thank you" in it', () => {
    for (const text of [
      'Thank you note for Sam, send it tomorrow.',
      'Call mom and say thank you',
      'you know what, buy olive oil',
      '.',
      '',
    ]) {
      expect(isSilenceHallucination(text), text).toBe(false)
    }
  })

  test('a hallucination is no speech on a short clip, or when the draft has no words', () => {
    expect(
      transcriptIsNoSpeech('Thank you.', { durationMs: 3000, draft: 'buy olive oil now please' }),
    ).toBe(true)
    expect(transcriptIsNoSpeech('Thank you.', { durationMs: 60_000, draft: '' })).toBe(true)
    expect(transcriptIsNoSpeech('Thank you.', { durationMs: 60_000, draft: 'thank you' })).toBe(
      false,
    )
    expect(transcriptIsNoSpeech(' .', { durationMs: 60_000, draft: 'x' })).toBe(true)
    // A long real transcript is never discarded.
    const long = 'Thank you for the help today, I need to call the bank tomorrow morning.'
    expect(transcriptIsNoSpeech(long, { durationMs: 2000, draft: '' })).toBe(false)
  })
})

describe('the phone draft as a fallback', () => {
  test('needs more than three words of real content', () => {
    expect(isUsableDraft('Remind me to buy olive oil tomorrow')).toBe(true)
    expect(isUsableDraft('bukra lazem eb3at el report')).toBe(true)
    expect(isUsableDraft('buy olive oil')).toBe(false)
    expect(isUsableDraft('Thank you. Thank you. Thank you. Thank you.')).toBe(false)
    expect(isUsableDraft('Thanks for watching')).toBe(false)
    expect(isUsableDraft('')).toBe(false)
    expect(isUsableDraft(null)).toBe(false)
    expect(wordCount('  [BLANK_AUDIO] hi there, you. ')).toBe(3)
  })
})
