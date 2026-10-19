import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, test } from 'vite-plus/test'
import { assembleSegments, hashFile } from './assemble'
import { createSha256 } from './sha256'
import { memoryIo, wavFile } from './test-io'

const reference = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

describe('streaming SHA-256', () => {
  test.each([0, 1, 55, 56, 63, 64, 65, 1000, 3 * 1024 * 1024 + 7])('%i bytes', (n) => {
    const bytes = new Uint8Array(randomBytes(n))
    const h = createSha256()
    // Odd-sized pieces cross block boundaries.
    for (let i = 0; i < n; i += 977) h.update(bytes.subarray(i, i + 977))
    expect(h.hex()).toBe(reference(bytes))
  })

  test('a file hashed in chunks matches the whole', async () => {
    const io = memoryIo()
    const bytes = new Uint8Array(randomBytes(2 * 1024 * 1024 + 123))
    io.create('f', bytes)
    expect(await hashFile(io, 'f')).toBe(reference(bytes))
  })

  test('a big file yields to the UI every 8 MB and still matches', async () => {
    const io = memoryIo()
    const bytes = new Uint8Array(randomBytes(17 * 1024 * 1024 + 5))
    io.create('f', bytes)
    let pauses = 0
    const digest = await hashFile(io, 'f', async () => {
      pauses += 1
    })
    expect(digest).toBe(reference(bytes))
    expect(pauses).toBe(2)
  })

  test('joining big segments yields too, and the digest matches the joined file', async () => {
    const io = memoryIo()
    // 16 kHz mono 16-bit: 5 minutes is ~9.6 MB per segment.
    io.create('a', wavFile(16_000 * 300, { fill: 1 }))
    io.create('b', wavFile(16_000 * 300, { fill: 2 }))
    let pauses = 0
    const plan = await assembleSegments(['a', 'b'], 'out', io, async () => {
      pauses += 1
    })
    expect(plan?.sha256).toBe(reference(io.files.get('out') ?? new Uint8Array()))
    expect(pauses).toBe(2)
  })
})
