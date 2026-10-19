/**
 * Operator warnings for server transcription. whisper-server `--convert` answers the same
 * `500 "FFmpeg conversion failed."` for a damaged recording and for a broken setup (ffmpeg not on
 * its PATH, an unwritable `--tmp-dir`). One such failure is a bad file; several in a row are
 * almost certainly the setup, so we say so in the log.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EngineError, type Transcriber } from '@bullet/engine'

/** Whether `ffmpeg` runs from this process's PATH (whisper-server `--convert` shells out to it). */
export function ffmpegAvailable(
  run: (cmd: string, args: string[]) => { status: number | null; error?: Error } = (cmd, args) =>
    spawnSync(cmd, args, { stdio: 'ignore', timeout: 5_000 }),
): boolean {
  const res = run('ffmpeg', ['-version'])
  return !res.error && res.status === 0
}

const isConversionFailure = (err: unknown) =>
  err instanceof EngineError &&
  err.code === 'TRANSCRIPTION_FAILED' &&
  /conversion failed/i.test(err.message)

/**
 * Wrap a transcriber to warn once `threshold` different recordings in a row failed ffmpeg
 * conversion. Retries of the same recording count once; any successful transcription resets it.
 */
export function watchConversionFailures(
  inner: Transcriber,
  opts: { threshold?: number; warn: (message: string) => void },
): Transcriber {
  const threshold = opts.threshold ?? 3
  let failed = new Set<string>()
  return {
    async transcribe(req) {
      try {
        const res = await inner.transcribe(req)
        failed = new Set()
        return res
      } catch (err) {
        if (isConversionFailure(err)) {
          const key = createHash('sha256').update(req.audio).digest('hex')
          const fresh = !failed.has(key)
          failed.add(key)
          const streak = failed.size
          if (fresh && streak % threshold === 0) {
            opts.warn(
              `${streak} recordings in a row failed ffmpeg conversion in whisper-server. ` +
                "Check that ffmpeg is on whisper-server's PATH and that its --tmp-dir is writable.",
            )
          }
        }
        throw err
      }
    },
  }
}
