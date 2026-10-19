/**
 * @bullet/client — everything a Bullet client (phone, web) shares that isn't tied to a runtime:
 * the local mirror (schema, migrations, local writes, outbox, pull merge, queries), the sync
 * client (push, pull, resumable audio upload) and the pure feature models and copy.
 *
 * Runtime edges are injected, never imported here:
 *  - the database: any synchronous Drizzle SQLite handle over `schema` (`PhoneDb`) — expo-sqlite
 *    on the phone, better-sqlite3 in tests, a browser SQLite later. Open it, then `migrate(db)`.
 *  - the network: `createHttpTransport({ fetch })` (any `fetch`-compatible function).
 *  - recordings on disk: `createSyncClient({ readAudioChunk })`.
 *  - clock, ids, time zone: `LocalDeps`.
 */

// The local mirror.
export * from './data/connections'
export * from './data/db'
export * from './data/decisions'
export * from './data/local'
export * from './data/migrations.gen'
export * from './data/mirror'
export * from './data/queries'
export * from './data/rejections'
export * from './data/schema'

// Sync.
export * from './sync/audio-path'
export * from './sync/client'
export * from './sync/transport'

// Pure feature models and copy.
export * from './features/capture/composer'
export * from './features/capture/counts'
export * from './features/capture/notice'
export * from './features/capture/pinned'
export * from './features/connections/copy'
export * from './features/connections/model'
export * from './features/inbox/edit'
export * from './features/inbox/model'
export * from './features/inbox/summary'
export * from './features/inbox/undo'
export * from './features/journal/audio-only'
export * from './features/journal/capture'
export * from './features/journal/format'
export * from './features/journal/loops'
export * from './features/journal/plans'
export * from './features/journal/stream'
export * from './features/journal/things'
export * from './features/journal/trackers'
export * from './features/reflect/direction'
export * from './features/reflect/model'
export * from './features/reflect/wording'
export * from './features/setup/pairing'
export * from './features/setup/settings'
export * from './features/store'
export * from './features/sync/live'
export * from './features/sync/monitor'
export * from './features/voice/access'
export * from './features/voice/assemble'
export * from './features/voice/attempts'
export * from './features/voice/format'
export * from './features/voice/return'
export * from './features/voice/save'
export * from './features/voice/session'
export * from './features/voice/sha256'
export * from './features/voice/wav'

// Two modules each define their own `startOfDay` / `spokenDuration`: the Journal's versions keep
// the plain names, the other two are renamed here.
export { spokenDuration, startOfDay } from './features/journal/format'
export { startOfDay as inboxStartOfDay } from './features/inbox/model'
export { spokenDuration as recordingSpokenDuration } from './features/voice/format'
