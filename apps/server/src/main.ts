import { serve } from '@hono/node-server'
import { createOpenAiCompatibleClient, ENGINE_CONFIG_DEFAULTS } from '@bullet/engine'
import { createApp } from './app'
import { loadServerConfig } from './config'
import { openDb } from './db/client'
import { recoverStuckJobs } from './queue/jobs'
import { createWorker } from './queue/worker'
import { createFileAudioStore } from './storage/audio-store'

const config = loadServerConfig(process.env)
const { db } = openDb(config.dbPath)
const audioStore = createFileAudioStore(config.audioDir)

const recovered = recoverStuckJobs(db, Date.now())
if (recovered > 0) console.log(`recovered ${recovered} job(s) interrupted by the last shutdown`)

const worker = createWorker({
  db,
  // The adapter's own abort is a backstop just past the worker's deadline.
  llm: createOpenAiCompatibleClient({
    baseUrl: config.llmBaseUrl,
    apiKey: config.llmApiKey,
    timeoutMs: config.llmTimeoutMs + 5_000,
  }),
  engine: { ...ENGINE_CONFIG_DEFAULTS, model: config.llmModel },
  llmTimeoutMs: config.llmTimeoutMs,
  // No transcriber is wired yet (whisper.cpp comes next): voice bullets use their device draft.
  audioStore,
  // Processing failures are recorded on the bullet; the log line is for the operator.
  onError: (err) => console.error('[worker]', err instanceof Error ? err.message : err),
})
worker.start()

const app = createApp({
  db,
  audioStore,
  onWorkQueued: () => worker.kick(),
  onError: (err) => console.error('[http]', err),
})

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`bullet server listening on http://${info.address}:${info.port}`)
})
