/** Vitest-only: an in-memory file system implementing `VoiceStoreIo`, plus WAV fixtures. */

import type { VoiceStoreIo } from './save'
import { type PcmFormat, VOICE_FORMAT, wavHeader } from './wav'

export function memoryIo(): VoiceStoreIo & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>()
  const dirs = new Set<string>()
  const get = (uri: string) => {
    const f = files.get(uri)
    if (!f) throw new Error(`no such file: ${uri}`)
    return f
  }
  const concat = (a: Uint8Array, b: Uint8Array) => {
    const out = new Uint8Array(a.length + b.length)
    out.set(a)
    out.set(b, a.length)
    return out
  }
  return {
    files,
    exists: (uri) => files.has(uri) || dirs.has(uri),
    size: (uri) => get(uri).length,
    read: (uri, offset, length) => get(uri).slice(offset, offset + length),
    create: (uri, bytes) => void files.set(uri, bytes.slice()),
    append: (uri, bytes) => void files.set(uri, concat(get(uri), bytes)),
    list: (dir) => {
      const names = new Set<string>()
      for (const uri of [...files.keys(), ...dirs]) {
        if (uri === dir || !uri.startsWith(dir)) continue
        const rest = uri.slice(dir.length)
        names.add(rest.split('/')[0] ?? rest)
      }
      return [...names].filter((n) => n !== '')
    },
    readText: (uri) => {
      const f = files.get(uri)
      return f ? new TextDecoder().decode(f) : null
    },
    writeText: (uri, text) => void files.set(uri, new TextEncoder().encode(text)),
    ensureDir: (dir) => void dirs.add(dir),
    remove: (uri) => {
      for (const k of files.keys()) if (k === uri || k.startsWith(uri)) files.delete(k)
      for (const d of dirs) if (d.startsWith(uri)) dirs.delete(d)
    },
    move: (from, to) => {
      files.set(to, get(from))
      files.delete(from)
    },
    sha256: async () => null,
  }
}

/** A WAV file with `samples` 16-bit samples of value `fill`. `stale` writes a 0 data size. */
export function wavFile(
  samples: number,
  opts: { fill?: number; stale?: boolean; format?: PcmFormat; filler?: number } = {},
): Uint8Array {
  const format = opts.format ?? VOICE_FORMAT
  const dataBytes = samples * (format.bitsPerSample / 8) * format.channels
  const header = wavHeader(format, opts.stale ? 0 : dataBytes)
  // Optionally put an Apple-style 'FLLR' padding chunk between 'fmt ' and 'data'.
  const filler = opts.filler ?? 0
  const pad = filler > 0 ? 8 + filler : 0
  const out = new Uint8Array(header.length + pad + dataBytes)
  out.set(header.subarray(0, 36))
  if (pad > 0) {
    out.set([0x46, 0x4c, 0x4c, 0x52], 36)
    new DataView(out.buffer).setUint32(40, filler, true)
  }
  out.set(header.subarray(36), 36 + pad)
  out.fill(opts.fill ?? 7, header.length + pad)
  return out
}
