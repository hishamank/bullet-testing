/**
 * Where voice-note bytes live on the home server. Kept forever (the database soft-deletes the
 * attachment row; the file stays). Positional writes make a resumed upload safe: re-writing a
 * range after a crash simply overwrites the same bytes.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'

export interface AudioStore {
  /** Write `bytes` at `offset` (creating the file if needed). */
  write(key: string, offset: number, bytes: Uint8Array): void
  read(key: string): Uint8Array
}

const safeKey = (key: string): string => {
  if (!/^[0-9a-f-]{36}$/.test(key)) throw new Error(`invalid audio storage key: ${key}`)
  return key
}

/** Files under `dir`, one per attachment. */
export function createFileAudioStore(dir: string): AudioStore {
  mkdirSync(dir, { recursive: true })
  return {
    write(key, offset, bytes) {
      const path = join(dir, safeKey(key))
      const fd = openSync(path, existsSync(path) ? 'r+' : 'w+')
      try {
        writeSync(fd, bytes, 0, bytes.length, offset)
      } finally {
        closeSync(fd)
      }
    },
    read(key) {
      return new Uint8Array(readFileSync(join(dir, safeKey(key))))
    },
  }
}

/** In memory, for tests. */
export function createMemoryAudioStore(): AudioStore & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>()
  return {
    files,
    write(key, offset, bytes) {
      const prev = files.get(key) ?? new Uint8Array(0)
      const next = new Uint8Array(Math.max(prev.length, offset + bytes.length))
      next.set(prev)
      next.set(bytes, offset)
      files.set(key, next)
    },
    read(key) {
      const f = files.get(key)
      if (!f) throw new Error(`no audio ${key}`)
      return f
    },
  }
}
