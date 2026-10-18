import { expect, test } from 'vite-plus/test'
import { audioAttachmentSelectSchema, MAX_AUDIO_BYTES, transcriptSelectSchema } from './audio'

const base = {
  owner_id: '22222222-2222-4222-8222-222222222222',
  created_at: 1,
  updated_at: 1,
  state: 'active' as const,
}
const attachment = {
  ...base,
  id: '11111111-1111-4111-8111-111111111111',
  bullet_id: '33333333-3333-4333-8333-333333333333',
  mime_type: 'audio/mp4',
  duration_ms: 12_500,
  size_bytes: 200_000,
  sha256: 'a'.repeat(64),
  upload_status: 'pending' as const,
  received_bytes: 0,
}

test('audio attachment: valid parses; sha256 optional (null)', () => {
  expect(audioAttachmentSelectSchema.parse(attachment)).toEqual(attachment)
  expect(audioAttachmentSelectSchema.safeParse({ ...attachment, sha256: null }).success).toBe(true)
})

test('audio attachment: rejects non-audio MIME, empty or oversized files, bad digests', () => {
  for (const bad of [
    { mime_type: 'video/mp4' },
    { size_bytes: 0 },
    { size_bytes: MAX_AUDIO_BYTES + 1 },
    { sha256: 'XYZ' },
  ]) {
    expect(audioAttachmentSelectSchema.safeParse({ ...attachment, ...bad }).success).toBe(false)
  }
})

test('transcripts: device draft and server, several languages, empty text allowed', () => {
  const t = {
    ...base,
    id: '44444444-4444-4444-8444-444444444444',
    bullet_id: attachment.bullet_id,
    attachment_id: attachment.id,
    transcribed_at: 1,
  }
  expect(
    transcriptSelectSchema.safeParse({
      ...t,
      kind: 'device_draft',
      text: 'call mom bukra',
      engine: 'apple-speechanalyzer',
      model: null,
      languages: ['en-US'],
    }).success,
  ).toBe(true)
  expect(
    transcriptSelectSchema.safeParse({
      ...t,
      kind: 'server',
      text: '',
      engine: 'whisper.cpp',
      model: 'large-v3-turbo',
      languages: ['en', 'ar', 'fr'],
    }).success,
  ).toBe(true)
  expect(
    transcriptSelectSchema.safeParse({
      ...t,
      kind: 'cloud',
      text: 'x',
      engine: 'e',
      model: null,
      languages: [],
    }).success,
  ).toBe(false)
})
