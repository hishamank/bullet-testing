import { describe, expect, test } from 'vite-plus/test'
import { wavFile } from './test-io'
import { parseWav, planConcat, VOICE_FORMAT, WAV_HEADER_BYTES, wavHeader } from './wav'

const seg = (uri: string, bytes: Uint8Array) => ({ uri, head: bytes, size: bytes.length })

describe('WAV headers', () => {
  test('a header it writes parses back to the same format and length', () => {
    const file = wavFile(16_000)
    expect(parseWav(file, file.length)).toEqual({
      format: VOICE_FORMAT,
      dataOffset: WAV_HEADER_BYTES,
      dataBytes: 32_000,
    })
  })

  test("skips Apple's FLLR padding chunk to find the samples", () => {
    const file = wavFile(100, { filler: 4040 })
    expect(parseWav(file, file.length)).toMatchObject({ dataOffset: 4092, dataBytes: 200 })
  })

  test('a header never finalised (killed app) takes its length from the file size', () => {
    const file = wavFile(500, { stale: true })
    expect(parseWav(file, file.length)?.dataBytes).toBe(1000)
  })

  test('a half-written last sample is dropped, a too-big declared size is clamped', () => {
    const file = wavFile(10)
    expect(parseWav(file, file.length + 1)?.dataBytes).toBe(20)
    expect(parseWav(file.slice(0, file.length - 3), file.length - 3)?.dataBytes).toBe(16)
  })

  test('not a WAV, or no data chunk yet → null', () => {
    expect(parseWav(new TextEncoder().encode('hello world, not a wav'), 22)).toBeNull()
    const headOnly = wavHeader(VOICE_FORMAT, 0).slice(0, 36)
    expect(parseWav(headOnly, 36)).toBeNull()
  })
})

describe('joining segments', () => {
  test('one header, every segment’s samples in order, duration from the bytes', () => {
    const a = wavFile(16_000, { fill: 1 })
    const b = wavFile(8_000, { fill: 2, stale: true, filler: 100 })
    const plan = planConcat([seg('a', a), seg('b', b)])
    expect(plan).toMatchObject({
      dataBytes: 48_000,
      sizeBytes: 48_044,
      durationMs: 1500,
      copies: [
        { uri: 'a', offset: 44, length: 32_000 },
        { uri: 'b', offset: 152, length: 16_000 },
      ],
      skipped: [],
    })
    expect(parseWav(plan?.header ?? new Uint8Array(), 48_044)?.dataBytes).toBe(48_000)
  })

  test('empty or broken segments are skipped; nothing at all → null', () => {
    const empty = wavFile(0)
    const plan = planConcat([seg('e', empty), seg('x', new Uint8Array(3)), seg('a', wavFile(4))])
    expect(plan?.skipped).toEqual(['e', 'x'])
    expect(plan?.dataBytes).toBe(8)
    expect(planConcat([seg('e', empty)])).toBeNull()
  })

  test('a segment in another format is refused rather than joined into noise', () => {
    const other = wavFile(4, { format: { ...VOICE_FORMAT, sampleRate: 44_100 } })
    expect(() => planConcat([seg('a', wavFile(4)), seg('b', other)])).toThrow(/different/)
  })
})
