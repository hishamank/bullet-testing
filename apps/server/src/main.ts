import { serve } from '@hono/node-server'
import { createOpenAiCompatibleClient, createWhisperCppTranscriber } from '@bullet/engine'
import { createApp } from './app'
import { engineConfig, loadServerConfig } from './config'
import { openDb } from './db/client'
import { recoverStuckJobs } from './queue/jobs'
import { createWorker } from './queue/worker'
import { ffmpegAvailable, watchConversionFailures } from './ops/whisper-health'
import { createFileAudioStore } from './storage/audio-store'
import { recoverStuckReflectJobs } from './reflect/capture'
import { scheduleReflectionPass } from './reflect/pass'

const config = loadServerConfig(process.env)
const { db } = openDb(config.dbPath)
const audioStore = createFileAudioStore(config.audioDir)

const recovered = recoverStuckJobs(db, Date.now())
if (recovered > 0) console.log(`recovered ${recovered} job(s) interrupted by the last shutdown`)
recoverStuckReflectJobs(db, Date.now())

const worker = createWorker({
  db,
  // The adapter's own abort is a backstop just past the worker's deadline.
  llm: createOpenAiCompatibleClient({
    baseUrl: config.llmBaseUrl,
    apiKey: config.llmApiKey,
    timeoutMs: config.llmTimeoutMs + 5_000,
  }),
  engine: engineConfig(config),
  llmTimeoutMs: config.llmTimeoutMs,
  // Without WHISPER_BASE_URL, voice bullets are processed on their device draft.
  transcriber: config.whisperBaseUrl
    ? watchConversionFailures(
        createWhisperCppTranscriber({
          baseUrl: config.whisperBaseUrl,
          model: config.whisperModel,
          prompt: config.whisperPrompt,
          timeoutMs: config.transcribeTimeoutMs + 5_000,
        }),
        { warn: (m) => console.warn(`[whisper] WARNING: ${m}`) },
      )
    : undefined,
  transcriberTimeoutMs: config.transcribeTimeoutMs,
  audioStore,
  // Processing failures are recorded on the bullet; the log line is for the operator.
  onError: (err) => console.error('[worker]', err instanceof Error ? err.message : err),
})
worker.start()
// Snoozed questions coming back, "Still on your mind?" and evergreen questions: once a day.
scheduleReflectionPass(db, {
  onError: (err) => console.error('[reflect]', err instanceof Error ? err.message : err),
})

const app = createApp({
  db,
  audioStore,
  onWorkQueued: () => worker.kick(),
  onError: (err) => console.error('[http]', err),
})

console.log(`llm: ${config.llmBaseUrl} (model ${config.llmModel})`)
if (config.whisperBaseUrl && !ffmpegAvailable()) {
  // whisper-server --convert needs ffmpeg; usually it runs on this same machine and PATH.
  console.warn(
    '[whisper] WARNING: ffmpeg is not on the PATH. whisper-server --convert needs it to read ' +
      'recordings; without it every voice note fails with transcription_failed.',
  )
}
console.log(
  config.whisperBaseUrl
    ? `whisper: ${config.whisperBaseUrl} (model ${config.whisperModel})`
    : 'whisper: not configured, voice notes use their device draft',
)

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`bullet server listening on http://${info.address}:${info.port}`)
})
