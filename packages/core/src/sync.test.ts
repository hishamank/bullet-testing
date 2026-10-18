import { describe, expect, test } from 'vite-plus/test'
import {
  MAX_PUSH_OPS,
  pullQuerySchema,
  pullResponseSchema,
  pushOpSchema,
  pushRequestSchema,
  pushResponseSchema,
} from './sync'

const OP = '11111111-1111-4111-8111-111111111111'
const BULLET = '22222222-2222-4222-8222-222222222222'

const createOp = {
  op_id: OP,
  type: 'bullet.create' as const,
  bullet: {
    id: BULLET,
    text: 'dentist thursday 3pm',
    captured_at: 1_700_000_000_000,
    timezone: 'Europe/Paris',
    source: 'voice' as const,
  },
}

describe('push', () => {
  test('accepts every op type', () => {
    const ops = [
      createOp,
      { op_id: OP, type: 'bullet.edit', bullet_id: BULLET, text: 'x', edited_at: 1 },
      { op_id: OP, type: 'bullet.delete', bullet_id: BULLET, mode: 'cascade' },
      { op_id: OP, type: 'bullet.delete', bullet_id: BULLET, mode: 'keep_extractions' },
      { op_id: OP, type: 'bullet.retry', bullet_id: BULLET },
      { op_id: OP, type: 'suggestion.accept', suggestion_id: BULLET },
      { op_id: OP, type: 'suggestion.accept', suggestion_id: BULLET, payload: { title: 'y' } },
      { op_id: OP, type: 'suggestion.reject', suggestion_id: BULLET },
      { op_id: OP, type: 'suggestion.undo', suggestion_id: BULLET },
      { op_id: OP, type: 'thought.reclassify', thought_id: BULLET, kind: 'worry' },
      { op_id: OP, type: 'question.dismiss', question_id: BULLET },
      { op_id: OP, type: 'question.answer', question_id: BULLET, option: 'Next Thursday' },
      { op_id: OP, type: 'thought.resolve', thought_id: BULLET },
      { op_id: OP, type: 'thought.unresolve', thought_id: BULLET },
      { op_id: OP, type: 'task.update', task_id: BULLET, patch: { status: 'done' } },
      { op_id: OP, type: 'task.update', task_id: BULLET, patch: { title: 'x', due_at: null } },
      { op_id: OP, type: 'task.delete', task_id: BULLET },
      { op_id: OP, type: 'event.update', event_id: BULLET, patch: { starts_at: 1, ends_at: 2 } },
      { op_id: OP, type: 'event.delete', event_id: BULLET },
      { op_id: OP, type: 'tracker_entry.update', tracker_entry_id: BULLET, patch: { value: 4 } },
      { op_id: OP, type: 'tracker_entry.delete', tracker_entry_id: BULLET },
      { ...createOp, bullet: { ...createOp.bullet, resolves_thought_id: BULLET } },
    ]
    for (const op of ops) expect(pushOpSchema.safeParse(op).success, op.type).toBe(true)
  })

  test('manual edits carry a non-empty patch of the editable fields only', () => {
    const bad = [
      { op_id: OP, type: 'task.update', task_id: BULLET, patch: {} },
      // Only complete / reopen by hand in slice 1.
      { op_id: OP, type: 'task.update', task_id: BULLET, patch: { status: 'cancelled' } },
      { op_id: OP, type: 'task.update', task_id: BULLET, patch: { notes: 'x' } },
      { op_id: OP, type: 'event.update', event_id: BULLET, patch: { location: 'x' } },
      { op_id: OP, type: 'tracker_entry.update', tracker_entry_id: BULLET, patch: {} },
      { op_id: OP, type: 'question.answer', question_id: BULLET, option: '' },
    ]
    for (const op of bad) expect(pushOpSchema.safeParse(op).success, JSON.stringify(op)).toBe(false)
  })

  test('a voice capture can carry its recording and the device draft', () => {
    const audio = {
      id: OP,
      mime_type: 'audio/mp4',
      duration_ms: 4_000,
      size_bytes: 64_000,
      sha256: null,
      draft: {
        text: 'dentist thursday 3pm',
        engine: 'apple-speechanalyzer',
        model: null,
        languages: ['en-US'],
      },
    }
    const voice = { ...createOp, bullet: { ...createOp.bullet, audio, text_edited_by_user: true } }
    expect(pushOpSchema.safeParse(voice).success).toBe(true)
    // Audio only on voice bullets.
    const typed = { ...voice, bullet: { ...voice.bullet, source: 'text' } }
    expect(pushOpSchema.safeParse(typed).success).toBe(false)
  })

  test('rejects an unknown op type and a non-uuid op_id', () => {
    expect(pushOpSchema.safeParse({ ...createOp, type: 'bullet.explode' }).success).toBe(false)
    expect(pushOpSchema.safeParse({ ...createOp, op_id: 'abc' }).success).toBe(false)
  })

  test('a capture needs a client-minted uuid, capture time and timezone', () => {
    const { timezone, ...noTz } = createOp.bullet
    void timezone
    expect(pushOpSchema.safeParse({ ...createOp, bullet: noTz }).success).toBe(false)
    expect(
      pushOpSchema.safeParse({ ...createOp, bullet: { ...createOp.bullet, id: 'x' } }).success,
    ).toBe(false)
  })

  test('batch size is bounded', () => {
    expect(pushRequestSchema.safeParse({ ops: [] }).success).toBe(false)
    const many = Array.from({ length: MAX_PUSH_OPS + 1 }, () => createOp)
    expect(pushRequestSchema.safeParse({ ops: many }).success).toBe(false)
  })

  test('response: rejected results carry an error code', () => {
    expect(
      pushResponseSchema.safeParse({
        server_time: 1,
        results: [
          { op_id: OP, status: 'applied' },
          { op_id: OP, status: 'duplicate' },
          { op_id: OP, status: 'rejected', error: { code: 'stale', message: 'older edit' } },
        ],
      }).success,
    ).toBe(true)
    expect(
      pushResponseSchema.safeParse({ server_time: 1, results: [{ op_id: OP, status: 'rejected' }] })
        .success,
    ).toBe(false)
  })
})

describe('pull', () => {
  test('query: cursor optional, limit coerced from the query string and bounded', () => {
    expect(pullQuerySchema.parse({})).toEqual({})
    expect(pullQuerySchema.parse({ cursor: '42', limit: '10' })).toEqual({
      cursor: '42',
      limit: 10,
    })
    expect(pullQuerySchema.safeParse({ limit: '100000' }).success).toBe(false)
  })

  test('response: the server never sends saved_local', () => {
    const bullet = {
      id: BULLET,
      owner_id: OP,
      created_at: 1,
      updated_at: 1,
      state: 'active',
      text: 'x',
      captured_at: 1,
      timezone: 'UTC',
      source: 'text',
      text_edited_by_user: false,
      answers_question_id: null,
      processing: {
        status: 'synced',
        attempts: 0,
        error: null,
        next_retry_at: null,
        updated_at: 1,
      },
    }
    const empty = {
      bullets: [],
      suggestions: [],
      tasks: [],
      events: [],
      trackers: [],
      tracker_entries: [],
      activities: [],
      audio_attachments: [],
      transcripts: [],
      thoughts: [],
      questions: [],
    }
    const ok = {
      cursor: '1',
      has_more: false,
      server_time: 1,
      changes: { ...empty, bullets: [bullet] },
    }
    expect(pullResponseSchema.safeParse(ok).success).toBe(true)
    const bad = {
      ...ok,
      changes: {
        ...empty,
        bullets: [{ ...bullet, processing: { ...bullet.processing, status: 'saved_local' } }],
      },
    }
    expect(pullResponseSchema.safeParse(bad).success).toBe(false)
  })
})
