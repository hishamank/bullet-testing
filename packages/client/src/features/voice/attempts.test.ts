import { describe, expect, test } from 'vite-plus/test'
import { createAttempts, endCause, endedFile } from './attempts'

describe('which file a native event belongs to', () => {
  test('a late end from the pause is credited to the paused segment, not the next one', () => {
    const log = createAttempts()
    log.begin('seg-001.wav')
    log.requestStop() // Pause
    log.begin('seg-002.wav') // a start that raced the native end
    log.audioEnd('file:///native/seg-001.wav')
    const first = log.end()
    expect(first?.file).toBe('seg-001.wav')
    expect(first && endCause(first)).toBe('requested')
    expect(first && endedFile(first, () => true)).toBe('file:///native/seg-001.wav')
    expect(log.end()?.file).toBe('seg-002.wav')
    expect(log.end()).toBeUndefined()
  })

  test('causes: interruption, real error, the recognizer giving up quietly', () => {
    const cause = (error: string | null) => {
      const log = createAttempts()
      log.begin('a')
      if (error) log.error(error)
      const a = log.end()
      return a ? endCause(a) : null
    }
    expect(cause('interrupted')).toBe('interrupted')
    expect(cause('audio-capture')).toBe('error')
    expect(cause('no-speech')).toBe('recognizer')
    expect(cause(null)).toBe('recognizer')
  })

  test('falls back to our own file name, or null when nothing was written', () => {
    const log = createAttempts()
    log.begin('seg-001.wav')
    const a = log.end()
    expect(a && endedFile(a, (u) => u === 'seg-001.wav')).toBe('seg-001.wav')
    expect(a && endedFile(a, () => false)).toBeNull()
  })
})
