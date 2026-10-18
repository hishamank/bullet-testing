/**
 * Run a folder of your own voice clips through one or more whisper-servers and write the
 * transcripts side by side, to judge mixed English / Lebanese Arabic / French quality by ear.
 *
 *   pnpm --filter server eval:transcribe --server turbo=http://127.0.0.1:8081
 *   pnpm --filter server eval:transcribe \
 *     --server turbo=http://127.0.0.1:8081 --server arabic-ft=http://127.0.0.1:8082 \
 *     --in eval/clips --out eval/out --prompt "Mixed English, Lebanese Arabic and French."
 *
 * Writes `<out>/transcripts.md` (one section per clip, one block per model) and
 * `<out>/transcripts.json`. `eval/` is git-ignored: never commit clips or transcripts.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createWhisperCppTranscriber, EngineError, type Transcriber } from '@bullet/engine'

const MIME: Record<string, string> = {
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.caf': 'audio/x-caf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.webm': 'audio/webm',
  '.flac': 'audio/flac',
}

const { values } = parseArgs({
  options: {
    in: { type: 'string', default: 'eval/clips' },
    out: { type: 'string', default: 'eval/out' },
    server: { type: 'string', multiple: true },
    prompt: { type: 'string' },
    'timeout-ms': { type: 'string', default: '600000' },
  },
})

const servers = (values.server ?? ['large-v3-turbo=http://127.0.0.1:8081']).map((s) => {
  const eq = s.indexOf('=')
  if (eq <= 0) throw new Error(`--server must be label=url, got "${s}"`)
  return { label: s.slice(0, eq), url: s.slice(eq + 1) }
})

interface Row {
  label: string
  text: string | null
  languages: string[]
  ms: number
  error: string | null
}

async function run(t: Transcriber, label: string, audio: Uint8Array, mime: string): Promise<Row> {
  const started = performance.now()
  try {
    const r = await t.transcribe({ audio, mimeType: mime })
    return {
      label,
      text: r.text,
      languages: r.languages,
      ms: performance.now() - started,
      error: null,
    }
  } catch (err) {
    const msg = err instanceof EngineError ? `${err.code}: ${err.message}` : String(err)
    return { label, text: null, languages: [], ms: performance.now() - started, error: msg }
  }
}

async function main() {
  const inDir = resolve(values.in!)
  const outDir = resolve(values.out!)
  const clips = readdirSync(inDir)
    .filter((f) => MIME[extname(f).toLowerCase()])
    .sort()
  if (clips.length === 0) throw new Error(`no audio clips in ${inDir}`)

  const transcribers = servers.map((s) => ({
    ...s,
    t: createWhisperCppTranscriber({
      baseUrl: s.url,
      model: s.label,
      prompt: values.prompt,
      timeoutMs: Number(values['timeout-ms']),
    }),
  }))

  const results: { clip: string; rows: Row[] }[] = []
  for (const clip of clips) {
    const audio = readFileSync(join(inDir, clip))
    const mime = MIME[extname(clip).toLowerCase()]!
    const rows: Row[] = []
    // One server at a time: they usually share one GPU.
    for (const { label, t } of transcribers) {
      const row = await run(t, label, audio, mime)
      console.log(
        `${clip} [${label}] ${(row.ms / 1000).toFixed(1)}s ${row.error ?? row.languages.join(',')}`,
      )
      rows.push(row)
    }
    results.push({ clip, rows })
  }

  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'transcripts.json'), JSON.stringify(results, null, 2))
  const md = [
    `# Transcription eval — ${new Date().toISOString()}`,
    '',
    `Models: ${servers.map((s) => `\`${s.label}\` (${s.url})`).join(', ')}`,
    values.prompt ? `Prompt: ${values.prompt}` : 'Prompt: none',
    '',
    ...results.flatMap(({ clip, rows }) => [
      `## ${basename(clip)}`,
      '',
      ...rows.flatMap((r) => [
        `**${r.label}** — ${(r.ms / 1000).toFixed(1)}s, detected: ${r.languages.join(', ') || '?'}`,
        '',
        r.error ? `> error: ${r.error}` : `> ${r.text!.replace(/\n/g, '\n> ')}`,
        '',
      ]),
    ]),
  ].join('\n')
  writeFileSync(join(outDir, 'transcripts.md'), md)
  console.log(`wrote ${join(outDir, 'transcripts.md')}`)
}

await main()
