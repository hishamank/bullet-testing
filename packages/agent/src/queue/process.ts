/**
 * processExtractJob — the per-job pipeline: load bullet → buildSnapshot → extractCandidates →
 * resolveCandidates → persist each as a Suggestion (with PROVENANCE) → AUTO-APPLY the 'auto'
 * ones → emit 'extraction:complete'.
 *
 * "Persist then apply": every resolved suggestion is stored first (so even auto ones are
 * auditable and re-acceptable), then the 'auto'-tier ones are accepted via @bullet/db's
 * `acceptSuggestion` — which RE-VALIDATES against current state, so a stale auto-apply fails
 * loudly rather than corrupting data.
 */

import { acceptSuggestion, createSuggestion, getBulletById, type Job } from '@bullet/db'
import type { AgentDeps } from '../deps'
import { AgentError } from '../errors'
import { extractCandidates } from '../extraction/extract'
import { buildSnapshot } from '../extraction/snapshot'
import { resolveCandidates, withProvenance } from '../resolution/resolve'

/** What processing one extraction job produced. */
export interface ProcessResult {
  /** Ids of every Suggestion persisted from this bullet. */
  suggestionIds: string[]
  /** Ids of the suggestions auto-applied (tier 'auto'). */
  appliedIds: string[]
  /** Count of candidates intentionally skipped (durable_fact / out-of-scope). */
  skipped: number
}

/** Read the `bulletId` out of a job payload (the queue's contract). */
function bulletIdOf(job: Job): string | undefined {
  const id = job.payload?.bulletId
  return typeof id === 'string' ? id : undefined
}

/**
 * Process a single `extract_bullet` job. Does NOT touch the job's status — the worker owns the
 * `claim → markDone/markFailed` transitions. Emits 'extraction:complete' on success.
 *
 * @throws AgentError('NOT_FOUND') when the job payload has no bulletId or the bullet is gone.
 */
export async function processExtractJob(deps: AgentDeps, job: Job): Promise<ProcessResult> {
  const bulletId = bulletIdOf(job)
  if (!bulletId) {
    throw new AgentError('NOT_FOUND', `extract job ${job.id} has no payload.bulletId`)
  }

  const bullet = getBulletById(deps.db, bulletId)
  if (bullet?.state !== 'active') {
    throw new AgentError('NOT_FOUND', `bullet not found or deleted: ${bulletId}`)
  }

  // 1) Snapshot the owner's current trackers + open tasks.
  const snapshot = buildSnapshot(deps, bullet.owner_id)

  // 2) Extract candidates with the live model (structured output, retried once internally).
  const candidates = await extractCandidates(deps, bullet.text, snapshot)

  // 3) Resolve to Suggestion INSERT drafts (routing + matching + tier).
  const { suggestions: drafts, skipped } = resolveCandidates(candidates, snapshot, deps.config)

  // 4) Persist each draft as a Suggestion, attaching provenance (owner_id + source_bullet_id).
  const suggestionIds: string[] = []
  const autoIds: string[] = []
  for (const draft of drafts) {
    const suggestion = createSuggestion(deps.db, withProvenance(draft, bullet.owner_id, bullet.id))
    suggestionIds.push(suggestion.id)
    if (suggestion.tier === 'auto') autoIds.push(suggestion.id)
  }

  // 5) Auto-apply the 'auto'-tier suggestions. acceptSuggestion re-validates against live state;
  // if one fails it stays pending (surfaced for the user) rather than failing the whole job.
  const appliedIds: string[] = []
  for (const id of autoIds) {
    try {
      acceptSuggestion(deps.db, id)
      appliedIds.push(id)
    } catch {
      // Leave it pending; a record that no longer applies cleanly becomes a normal suggestion.
    }
  }

  deps.emitter.emit('extraction:complete', {
    jobId: job.id,
    bulletId: bullet.id,
    suggestionIds,
    appliedIds,
  })

  return { suggestionIds, appliedIds, skipped }
}
