/**
 * @bullet/engine — the pure extraction → resolution pipeline: prompt building, structured-output
 * parsing with repair, deterministic matching, create-vs-append routing and tier assignment.
 *
 * No DB, no Node APIs: it runs on the server today and can run on-device later. Persistence,
 * queueing and apply live in the server.
 */

export { type EngineConfig, ENGINE_CONFIG_DEFAULTS } from './config'
export { EngineError, type EngineErrorCode } from './errors'
export * from './extraction'
export * from './llm'
export * from './resolution'
export * from './time'
export * from './transcription'
