import { describe, expect, test } from 'vite-plus/test'
import { resolveRecordingUri, storedRecordingPath } from './audio-path'

const OLD = 'file:///var/mobile/Containers/Data/Application/AAAA/Documents/'
const NEW = 'file:///var/mobile/Containers/Data/Application/BBBB/Documents/'

describe('recording paths survive a container change', () => {
  test('stored relative to Documents, resolved against whatever the container is today', () => {
    const stored = storedRecordingPath('s1.wav')
    expect(stored).toBe('recordings/s1.wav')
    expect(stored).not.toMatch(/AAAA|file:/)
    expect(resolveRecordingUri(stored, OLD, () => true)).toBe(`${OLD}recordings/s1.wav`)
    expect(resolveRecordingUri(stored, NEW.slice(0, -1), () => true)).toBe(
      `${NEW}recordings/s1.wav`,
    )
  })

  test('an old absolute path still works while it exists, else is found by name', () => {
    const legacy = `${OLD}recordings/s1.wav`
    expect(resolveRecordingUri(legacy, NEW, () => true)).toBe(legacy)
    expect(resolveRecordingUri(legacy, NEW, () => false)).toBe(`${NEW}recordings/s1.wav`)
  })
})
