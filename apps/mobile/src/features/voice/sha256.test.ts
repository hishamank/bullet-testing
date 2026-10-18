import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, test } from 'vite-plus/test'
import { hashFile } from './assemble'
import { createSha256 } from './sha256'
import { memoryIo } from './test-io'

const reference = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

describe('streaming SHA-256', () => {
  test.each([0, 1, 55, 56, 63, 64, 65, 1000, 3 * 1024 * 1024 + 7])('%i bytes', (n) => {
    const bytes = new Uint8Array(randomBytes(n))
    const h = createSha256()
    // Odd-sized pieces cross block boundaries.
    for (let i = 0; i < n; i += 977) h.update(bytes.subarray(i, i + 977))
    expect(h.hex()).toBe(reference(bytes))
  })

  test('a file hashed in chunks matches the whole', () => {
    const io = memoryIo()
    const bytes = new Uint8Array(randomBytes(2 * 1024 * 1024 + 123))
    io.create('f', bytes)
    expect(hashFile(io, 'f')).toBe(reference(bytes))
  })
})
