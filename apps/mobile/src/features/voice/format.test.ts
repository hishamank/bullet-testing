import { describe, expect, test } from 'vite-plus/test'
import { voiceAccess } from './access'
import { draftHint, formatTimer, pauseNote, spokenDuration } from './format'

describe('timer', () => {
  test.each([
    [0, '0:00', '0 seconds'],
    [7_900, '0:07', '7 seconds'],
    [192_000, '3:12', '3 minutes 12 seconds'],
    [60_000, '1:00', '1 minute'],
    [3_723_000, '1:02:03', '1 hour 2 minutes 3 seconds'],
  ])('%i ms → %s', (ms, text, spoken) => {
    expect(formatTimer(ms)).toBe(text)
    expect(spokenDuration(ms)).toBe(spoken)
  })
})

describe('microphone access', () => {
  const yes = { granted: true, canAskAgain: true }
  const notYet = { granted: false, canAskAgain: true }
  const no = { granted: false, canAskAgain: false }
  test.each([
    [notYet, notYet, true, 'ask'],
    [yes, notYet, true, 'ask'],
    [no, yes, true, 'blocked'],
    [yes, yes, true, 'draft'],
    [yes, no, true, 'record_only'],
    [yes, yes, false, 'record_only'],
  ] as const)('mic %o speech %o on-device %s → %s', (microphone, speech, onDeviceEnglish, kind) => {
    expect(voiceAccess({ microphone, speech, onDeviceEnglish }).kind).toBe(kind)
  })

  test('says why there is no live draft', () => {
    expect(voiceAccess({ microphone: yes, speech: no, onDeviceEnglish: true })).toEqual({
      kind: 'record_only',
      why: 'speech_denied',
    })
  })
})

describe('recording copy', () => {
  test('the draft label says the recording is kept, with or without a draft', () => {
    expect(draftHint(true, null)).toBe(
      'Live draft. Your recording is kept and transcribed again at home.',
    )
    expect(draftHint(false, 'speech_denied')).toMatch(/speech recognition is off.*kept/)
    expect(draftHint(false, null)).toMatch(/kept/)
  })

  test('every pause that the user did not ask for says the audio is safe', () => {
    expect(pauseNote('user')).toBeNull()
    for (const r of ['interrupted', 'background', 'error'] as const) {
      expect(pauseNote(r)).toBe('Recording paused. Everything so far is saved.')
    }
    expect(pauseNote('limit')).toMatch(/Send/)
  })
})
