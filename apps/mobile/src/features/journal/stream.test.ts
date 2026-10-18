import { describe, expect, test } from 'vite-plus/test'
import { captureBullet } from '../../data/local'
import { openTestDb, T0, testDeps } from '../../test/db'
import { seedAudio, seedBullet, seedSuggestion, seedThought, TZ } from './fixtures'
import {
  cardAccessibilityLabel,
  cardState,
  groupByDay,
  listCaptureCards,
  sourceLine,
} from './stream'

const D = 86_400_000

describe('stream query', () => {
  test('cards newest first, with thoughts in order, recording length and counts', () => {
    const db = openTestDb()
    const older = seedBullet(db, T0 - D, { text: 'ran 5k before work' })
    const voice = seedBullet(db, T0, { source: 'voice', text: 'long ramble' })
    seedAudio(db, voice, { duration_ms: 192_000 })
    seedThought(db, voice, 1, 'event', 'Dentist, Thursday 15:00')
    seedThought(db, voice, 0, 'worry', 'Uneasy about the meeting')
    seedThought(db, voice, 2, 'idea', 'gone', { state: 'deleted' })
    seedSuggestion(db, older, {
      target_kind: 'activity',
      payload: { name: 'Run' },
      status: 'accepted',
      auto_applied: true,
      applied_at: 5,
    })
    seedSuggestion(db, voice, { target_kind: 'event', payload: { title: 'Dentist' } })

    const { cards, hasMore } = listCaptureCards(db, 10)
    expect(hasMore).toBe(false)
    expect(cards.map((c) => c.id)).toEqual([voice, older])
    expect(cards[0]).toMatchObject({ durationMs: 192_000, pending: 1, autoApplied: 0 })
    expect(cards[0]?.thoughts.map((t) => t.kind)).toEqual(['worry', 'event'])
    expect(cards[1]).toMatchObject({ durationMs: null, autoApplied: 1, status: 'processed' })
  })

  test('pages by count and says when there is more', () => {
    const db = openTestDb()
    for (let i = 0; i < 5; i++) seedBullet(db, T0 - i * 1000)
    const first = listCaptureCards(db, 3)
    expect(first.cards).toHaveLength(3)
    expect(first.hasMore).toBe(true)
    expect(listCaptureCards(db, 5).hasMore).toBe(false)
  })

  test('a capture not yet confirmed by the server shows as on this phone', () => {
    const db = openTestDb()
    captureBullet(db, { text: 'book flights' }, testDeps())
    const [card] = listCaptureCards(db, 10).cards
    expect(card?.status).toBe('saved_local')
    expect(cardState(card!)).toMatchObject({ label: 'On this phone', onPhone: true })
  })

  test('deleted captures are left out', () => {
    const db = openTestDb()
    seedBullet(db, T0, { state: 'deleted' })
    expect(listCaptureCards(db, 10).cards).toEqual([])
  })
})

describe('grouping and wording', () => {
  test('groups by day in the zone, keeping order', () => {
    const items = [T0, T0 - 3_600_000, T0 - D, T0 - 3 * D]
    const sections = groupByDay(items, (x) => x, T0, TZ)
    expect(sections.map((s) => [s.title, s.data.length])).toEqual([
      ['Today', 2],
      ['Yesterday', 1],
      ['Mon 12 Oct', 1],
    ])
  })

  test('every state reads differently; failed offers Retry with a calm reason', () => {
    const base = { errorCode: null, autoApplied: 0, pending: 0 }
    const labels = (
      [
        'saved_local',
        'synced',
        'transcribing',
        'processing',
        'processed',
        'needs_review',
        'failed',
      ] as const
    ).map((status) => cardState({ ...base, status }).label)
    expect(new Set(labels).size).toBe(labels.length)
    expect(cardState({ ...base, status: 'failed', errorCode: 'llm_unavailable' })).toMatchObject({
      label: 'Not processed',
      retry: true,
      reason: "Home server's AI didn't respond.",
    })
    expect(cardState({ ...base, status: 'processed', autoApplied: 1 }).label).toBe('Done for you')
    expect(cardState({ ...base, status: 'synced', errorCode: 'llm_timeout' }).label).toBe(
      'Retrying…',
    )
  })

  test('source line and VoiceOver label', () => {
    const card = {
      id: 'x',
      text: 'long ramble',
      source: 'voice' as const,
      capturedAt: Date.UTC(2026, 9, 15, 6, 40),
      timezone: TZ,
      durationMs: 192_000,
      status: 'transcribing' as const,
      errorCode: null,
      attempts: 0,
      nextRetryAt: null,
      thoughts: [{ id: 't', kind: 'to_check' as const, text: 'passport expiry' }],
      autoApplied: 0,
      pending: 0,
    }
    expect(sourceLine(card)).toBe('Voice · 3:12 · 08:40')
    expect(sourceLine({ ...card, source: 'text' })).toBe('Typed · 08:40')
    expect(cardAccessibilityLabel(card)).toBe(
      'Voice note, 3 minutes 12 seconds. 08:40. Transcribing. to check: passport expiry',
    )
  })
})
