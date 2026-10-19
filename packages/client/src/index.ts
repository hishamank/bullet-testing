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
export * from './features/inbox/controller'
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
export * from './features/sync/controller'
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

// Two modules each define their own `startOfDay` / `spokenDuration`. The plain names below are the
// Journal's versions (`features/journal/format`: day math and "3 minutes 12 seconds" for the Stream and
// Capture detail). The Inbox's day start is exported as `inboxStartOfDay` and the voice recorder's
// spoken length as `recordingSpokenDuration`.

/**
 * The Journal's `startOfDay(at, tz, offset)`: epoch ms of local midnight, `offset` days away.
 * Not the Inbox's variant, which is exported as `inboxStartOfDay(now, tz)`.
 */
export { startOfDay } from './features/journal/format'
/**
 * The Journal's `spokenDuration(ms)` (VoiceOver length of a voice note on a card or in Capture
 * detail). The recorder's variant is exported as `recordingSpokenDuration`.
 */
export { spokenDuration } from './features/journal/format'
export { startOfDay as inboxStartOfDay } from './features/inbox/model'
export { spokenDuration as recordingSpokenDuration } from './features/voice/format'
