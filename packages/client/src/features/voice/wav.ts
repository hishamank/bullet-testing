/**
 * WAV (RIFF, linear PCM) headers, pure. A voice note is recorded as one WAV segment per stretch
 * of speaking (Pause ends a segment, Resume starts the next). On Send the segments' sample data is
 * joined behind one fresh header. A segment cut short by a crash or a kill has a stale header
 * (sizes 0 or too big): its real length is taken from the file size, so no audio is dropped.
 */

export interface PcmFormat {
  /** 1 = integer PCM, 3 = IEEE float. */
  audioFormat: number
  channels: number
  sampleRate: number
  bitsPerSample: number
}

export interface WavInfo {
  format: PcmFormat
  /** Where the sample data starts in the file. */
  dataOffset: number
  /** How many bytes of sample data the file really holds (whole frames only). */
  dataBytes: number
}

/** Bytes to read from the start of a segment to be sure to reach its `data` chunk. */
export const WAV_HEAD_BYTES = 64 * 1024

export const WAV_HEADER_BYTES = 44

/** What the speech recorder writes: 16 kHz mono 16-bit, which is also what Whisper wants. */
export const VOICE_FORMAT: PcmFormat = {
  audioFormat: 1,
  channels: 1,
  sampleRate: 16_000,
  bitsPerSample: 16,
}

export function bytesPerSecond(f: PcmFormat): number {
  return f.sampleRate * f.channels * (f.bitsPerSample / 8)
}

function blockAlign(f: PcmFormat): number {
  return f.channels * (f.bitsPerSample / 8)
}

export function durationMs(f: PcmFormat, dataBytes: number): number {
  return Math.round((dataBytes / bytesPerSecond(f)) * 1000)
}

function tag(b: Uint8Array, at: number): string {
  return String.fromCharCode(b[at] ?? 0, b[at + 1] ?? 0, b[at + 2] ?? 0, b[at + 3] ?? 0)
}

/**
 * Read a segment's format and where its samples are. `head` is the start of the file (at least
 * up to the `data` chunk header); `fileSize` is the whole file's size. Returns null when the file
 * is not a PCM WAV or holds no samples yet.
 */
export function parseWav(head: Uint8Array, fileSize: number): WavInfo | null {
  if (head.length < 12 || tag(head, 0) !== 'RIFF' || tag(head, 8) !== 'WAVE') return null
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
  let format: PcmFormat | null = null
  let at = 12
  while (at + 8 <= head.length) {
    const id = tag(head, at)
    const size = view.getUint32(at + 4, true)
    const body = at + 8
    if (id === 'fmt ') {
      if (body + 16 > head.length) return null
      format = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      }
    } else if (id === 'data') {
      if (!format || format.channels === 0 || format.bitsPerSample % 8 !== 0) return null
      // A header the writer never finalised says 0 (or a stale size): trust the file instead.
      const onDisk = Math.max(0, fileSize - body)
      const declared = size === 0 || size > onDisk ? onDisk : size
      const align = blockAlign(format)
      return { format, dataOffset: body, dataBytes: declared - (declared % align) }
    }
    // Chunks are word-aligned (Apple writers also add a large 'FLLR' padding chunk).
    at = body + size + (size % 2)
  }
  return null
}

export function sameFormat(a: PcmFormat, b: PcmFormat): boolean {
  return (
    a.audioFormat === b.audioFormat &&
    a.channels === b.channels &&
    a.sampleRate === b.sampleRate &&
    a.bitsPerSample === b.bitsPerSample
  )
}

/** A canonical 44-byte header for `dataBytes` of samples in `f`. */
export function wavHeader(f: PcmFormat, dataBytes: number): Uint8Array {
  const out = new Uint8Array(WAV_HEADER_BYTES)
  const view = new DataView(out.buffer)
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < 4; i++) out[at + i] = s.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, f.audioFormat, true)
  view.setUint16(22, f.channels, true)
  view.setUint32(24, f.sampleRate, true)
  view.setUint32(28, bytesPerSecond(f), true)
  view.setUint16(32, blockAlign(f), true)
  view.setUint16(34, f.bitsPerSample, true)
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  return out
}

export interface SegmentHead {
  uri: string
  head: Uint8Array
  size: number
}

export interface ConcatPlan {
  format: PcmFormat
  header: Uint8Array
  /** Byte ranges to copy, in order, after the header. */
  copies: { uri: string; offset: number; length: number }[]
  dataBytes: number
  sizeBytes: number
  durationMs: number
  /** Segments that held no audio (or weren't WAV): skipped, safe to delete. */
  skipped: string[]
}

/**
 * Plan joining the segments into one WAV. Empty or unreadable segments are skipped; a segment in a
 * different format than the first is an error (the recorder always writes `VOICE_FORMAT`).
 * Returns null when no segment holds any audio.
 */
export function planConcat(segments: readonly SegmentHead[]): ConcatPlan | null {
  let format: PcmFormat | null = null
  const copies: ConcatPlan['copies'] = []
  const skipped: string[] = []
  for (const s of segments) {
    const info = parseWav(s.head, s.size)
    if (!info || info.dataBytes === 0) {
      skipped.push(s.uri)
      continue
    }
    if (format && !sameFormat(format, info.format)) {
      throw new Error(`recording segment ${s.uri} has a different audio format`)
    }
    format ??= info.format
    copies.push({ uri: s.uri, offset: info.dataOffset, length: info.dataBytes })
  }
  if (!format) return null
  const dataBytes = copies.reduce((n, c) => n + c.length, 0)
  return {
    format,
    header: wavHeader(format, dataBytes),
    copies,
    dataBytes,
    sizeBytes: WAV_HEADER_BYTES + dataBytes,
    durationMs: durationMs(format, dataBytes),
    skipped,
  }
}
