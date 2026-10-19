import { describe, expect, test } from 'vite-plus/test'
import {
  BULLET_STATUS_TRANSITIONS,
  bulletProcessingStatusSchema,
  canTransition,
  displayStatus,
  isSettledStatus,
  isPermanentTranscriptionError,
  processingErrorCodeSchema,
  serverBulletProcessingStatusSchema,
} from './processing'

describe('bullet processing status', () => {
  test('the full state list is stable (the design contract depends on it)', () => {
    expect(bulletProcessingStatusSchema.options).toEqual([
      'saved_local',
      'synced',
      'transcribing',
      'processing',
      'processed',
      'needs_review',
      'failed',
    ])
  })

  test('saved_local is phone-only: the server status set excludes it', () => {
    expect(serverBulletProcessingStatusSchema.options).not.toContain('saved_local')
    expect(serverBulletProcessingStatusSchema.safeParse('saved_local').success).toBe(false)
  })

  test('every status has a transition entry', () => {
    for (const s of bulletProcessingStatusSchema.options) {
      expect(BULLET_STATUS_TRANSITIONS[s]).toBeDefined()
    }
  })

  test('the happy path and the review path are allowed', () => {
    expect(canTransition('saved_local', 'synced')).toBe(true)
    expect(canTransition('synced', 'processing')).toBe(true)
    expect(canTransition('processing', 'processed')).toBe(true)
    expect(canTransition('processing', 'needs_review')).toBe(true)
    expect(canTransition('needs_review', 'processed')).toBe(true)
  })

  test('failure, auto-retry, user retry and edit transitions', () => {
    expect(canTransition('processing', 'failed')).toBe(true)
    expect(canTransition('processing', 'synced')).toBe(true) // auto-retry scheduled
    expect(canTransition('failed', 'synced')).toBe(true) // user retry
    expect(canTransition('processed', 'synced')).toBe(true) // edited → re-extract
  })

  test('voice bullets transcribe before processing; transcription can fail and retry', () => {
    expect(canTransition('synced', 'transcribing')).toBe(true)
    expect(canTransition('transcribing', 'processing')).toBe(true)
    expect(canTransition('transcribing', 'failed')).toBe(true)
    expect(canTransition('transcribing', 'synced')).toBe(true)
    expect(canTransition('transcribing', 'processed')).toBe(false)
    expect(processingErrorCodeSchema.options).toContain('transcription_failed')
    expect(processingErrorCodeSchema.options).toContain('transcription_no_speech')
  })

  test('only corrupt audio and no speech are permanent transcription failures', () => {
    expect(isPermanentTranscriptionError('transcription_failed')).toBe(true)
    expect(isPermanentTranscriptionError('transcription_no_speech')).toBe(true)
    expect(isPermanentTranscriptionError('transcription_unavailable')).toBe(false)
    expect(isPermanentTranscriptionError('transcription_timeout')).toBe(false)
    expect(isPermanentTranscriptionError('llm_unavailable')).toBe(false)
    expect(isPermanentTranscriptionError(null)).toBe(false)
  })

  test('nonsense transitions are refused', () => {
    expect(canTransition('saved_local', 'processed')).toBe(false)
    expect(canTransition('synced', 'processed')).toBe(false)
    expect(canTransition('failed', 'processed')).toBe(false)
    expect(canTransition('processed', 'saved_local')).toBe(false)
  })

  test('settled statuses', () => {
    expect(isSettledStatus('processed')).toBe(true)
    expect(isSettledStatus('needs_review')).toBe(true)
    expect(isSettledStatus('failed')).toBe(true)
    expect(isSettledStatus('processing')).toBe(false)
  })

  test('displayStatus overlays saved_local while a local change is unsent', () => {
    expect(displayStatus(null, true)).toBe('saved_local')
    expect(displayStatus(null, false)).toBe('saved_local')
    expect(displayStatus('processed', true)).toBe('saved_local')
    expect(displayStatus('processed', false)).toBe('processed')
  })
})
