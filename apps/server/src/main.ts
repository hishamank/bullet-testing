import { serve } from '@hono/node-server'
import {
  createOpenAiCompatibleClient,
  createOpenAiCompatibleEmbedder,
  createWhisperCppTranscriber,
} from '@bullet/engine'
import { createApp } from './app'
import { engineConfig, loadServerConfig, nightlyEngineConfig } from './config'
import { openDb } from './db/client'
import { recoverStuckJobs } from './queue/jobs'
import { createWorker } from './queue/worker'
import { ffmpegAvailable, watchConversionFailures } from './ops/whisper-health'
import { createFileAudioStore } from './storage/audio-store'
import { recoverStuckReflectJobs } from './reflect/capture'
import { recoverStuckLinkJobs } from './connections/link-job'
import { scheduleReflectionPass } from './reflect/pass'

const config = loadServerConfig(process.env)
const { db } = openDb(config.dbPath)
const audioStore = createFileAudioStore(config.audioDir)

const recovered = recoverStuckJobs(db, Date.now())
if (recovered > 0) console.log(`recovered ${recovered} job(s) interrupted by the last shutdown`)
recoverStuckReflectJobs(db, Date.now())
recoverStuckLinkJobs(db, Date.now())

const embedder = createOpenAiCompatibleEmbedder({
  baseUrl: config.embedBaseUrl,
  model: config.embedModel,
  apiKey: config.embedApiKey,
  template: config.embedProfile.template,
  timeoutMs: config.embedTimeoutMs + 5_000,
})

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
  embedder,
  embedProfile: config.embedProfile,
  embedTimeoutMs: config.embedTimeoutMs,
  // Themes, link review and Noticed at 02:00 server time, with the nightly model if set.
  nightly: {
    llm: config.llmNightlyBaseUrl
      ? createOpenAiCompatibleClient({
          baseUrl: config.llmNightlyBaseUrl,
          apiKey: config.llmApiKey,
          timeoutMs: config.llmTimeoutMs + 5_000,
        })
      : undefined,
    engine: nightlyEngineConfig(config),
    timezone: config.timezone,
  },
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
console.log(
  `nightly: 02:00 ${config.timezone} (model ${config.llmNightlyModel ?? config.llmModel})`,
)
console.log(
  `embeddings: ${config.embedBaseUrl} (model ${config.embedModel}, ${config.embedProfile.name} profile, link at ${config.embedProfile.thresholds.link})`,
)
// A quick probe: llama-server only answers /v1/embeddings when started with --embeddings.
embedder.embed(['probe']).catch((err: unknown) => {
  console.warn(
    `[embed] WARNING: ${config.embedBaseUrl}/v1/embeddings is not answering (${err instanceof Error ? err.message : String(err)}). ` +
      'Connections wait until it does; see docs/home-server.md.',
  )
})
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
