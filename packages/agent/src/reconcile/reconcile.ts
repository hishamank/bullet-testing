/**
 * reprocessBullet (CLAUDE.md §4.7) — editing a bullet DROPS its previous analysis and re-runs
 * extraction, RECONCILING against already-applied extractions instead of blindly recreating.
 *
 * STRATEGY (documented here and in the README):
 *
 *   1. RETIRE STALE PENDING: reject every still-pending suggestion for the bullet — the old
 *      analysis no longer reflects the (edited) text.
 *   2. RE-EXTRACT: snapshot + extract + resolve the edited bullet into new Suggestion drafts.
 *   3. RECONCILE CREATES: for each new 'create' draft, look for a matching APPLIED entity from
 *      this bullet (active row, same target_kind, normalized key field — title/name). If found →
 *      KEEP it (skip; do not duplicate). Else → persist the draft as a new suggestion and
 *      auto-apply it when tier 'auto'. (append/update drafts are always persisted — they target
 *      a live definition/instance, not a from-this-bullet entity, so there is nothing to dedupe.)
 *   4. RETIRE REMOVED: any applied entity from this bullet that matches NO new 'create' draft is
 *      soft-deleted (the edit removed the thing that produced it).
 *
 * LIMITATIONS (intentional, v1):
 *   - Matching is SIMPLE: target_kind + a normalized key (task.title / tracker.name /
 *     activity.name). It does not diff field values — a kept entity is NOT updated to match new
 *     payload fields (e.g. a changed due date); it is kept as-is. Editing a value is future work.
 *   - tracker_entries are records under a definition; they are reconciled by their normalized
 *     value→name is not meaningful, so entries are matched by kind only when a 'create' targets
 *     them (rare in v1, since happened→entry is an 'append'); in practice entry rows from this
 *     bullet are retired-and-recreated by the append path. We keep them out of the create-dedupe
 *     set to avoid false "keeps".
 *   - Reconciliation is best-effort and NOT transactional across the whole reprocess; each step
 *     uses the same guarded repo/apply calls as normal extraction.
 */

import {
  getBulletById,
  listActivitiesBySourceBullet,
  listSuggestionsByBullet,
  listTasksBySourceBullet,
  listTrackersBySourceBullet,
  rejectSuggestion,
  softDeleteActivity,
  softDeleteTask,
  softDeleteTracker,
} from '@bullet/db'
import type { AgentDeps } from '../deps'
import { AgentError } from '../errors'
import { extractCandidates } from '../extraction/extract'
import { buildSnapshot } from '../extraction/snapshot'
import { persistAndAutoApply } from '../persist'
import type { ResolvedSuggestion } from '../resolution/resolve'
import { resolveCandidates } from '../resolution/resolve'

/** What a reprocess did — enough for the caller (and tests) to assert the reconciliation. */
export interface ReconcileResult {
  /** Pending suggestions rejected as stale at step 1. */
  retiredPendingIds: string[]
  /** New suggestions persisted at step 3 (creates that did not match an existing entity). */
  newSuggestionIds: string[]
  /** Newly-persisted suggestions that were auto-applied. */
  appliedIds: string[]
  /**
   * Newly-persisted 'auto'-tier suggestions whose auto-apply FAILED and so remain pending
   * (fail-soft). Surfaced rather than swallowed, mirroring `processExtractJob`.
   */
  failedAutoApplyIds: string[]
  /** Applied entities from this bullet KEPT because a new create matched them. */
  keptEntityIds: string[]
  /** Applied entities from this bullet RETIRED (soft-deleted) because nothing matched. */
  retiredEntityIds: string[]
}

/** A reconcilable applied entity: its id, kind, and the normalized key we match on. */
interface AppliedEntity {
  id: string
  kind: 'task' | 'tracker' | 'activity'
  key: string
  softDelete: () => void
}

/** Normalize a name/title for matching (lowercase, collapse whitespace, trim). */
function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Collect the applied entities traced to this bullet that we reconcile create-drafts against. */
function collectAppliedEntities(deps: AgentDeps, bulletId: string): AppliedEntity[] {
  const entities: AppliedEntity[] = []

  for (const task of listTasksBySourceBullet(deps.db, bulletId)) {
    entities.push({
      id: task.id,
      kind: 'task',
      key: normalizeKey(task.title),
      softDelete: () => softDeleteTask(deps.db, task.id),
    })
  }
  for (const tracker of listTrackersBySourceBullet(deps.db, bulletId)) {
    entities.push({
      id: tracker.id,
      kind: 'tracker',
      key: normalizeKey(tracker.name),
      softDelete: () => softDeleteTracker(deps.db, tracker.id),
    })
  }
  for (const activity of listActivitiesBySourceBullet(deps.db, bulletId)) {
    entities.push({
      id: activity.id,
      kind: 'activity',
      key: normalizeKey(activity.name),
      softDelete: () => softDeleteActivity(deps.db, activity.id),
    })
  }
  // tracker_entries are intentionally excluded (see module doc) — they are append records.
  return entities
}

/** The normalized key a 'create' draft would produce for its entity (or undefined). */
function draftKey(
  draft: ResolvedSuggestion,
): { kind: AppliedEntity['kind']; key: string } | undefined {
  if (draft.operation !== 'create') return undefined
  const p = draft.payload
  switch (draft.target_kind) {
    case 'task': {
      const title = typeof p.title === 'string' ? p.title : ''
      return { kind: 'task', key: normalizeKey(title) }
    }
    case 'tracker': {
      const name = typeof p.name === 'string' ? p.name : ''
      return { kind: 'tracker', key: normalizeKey(name) }
    }
    case 'activity': {
      const name = typeof p.name === 'string' ? p.name : ''
      return { kind: 'activity', key: normalizeKey(name) }
    }
    default:
      // tracker_entry create — not part of the dedupe set.
      return undefined
  }
}

/**
 * Reconcile a bullet's analysis after an edit. See the module-level STRATEGY.
 *
 * @throws AgentError('NOT_FOUND') if the bullet does not exist / is deleted.
 */
export async function reprocessBullet(deps: AgentDeps, bulletId: string): Promise<ReconcileResult> {
  const bullet = getBulletById(deps.db, bulletId)
  if (bullet?.state !== 'active') {
    throw new AgentError('NOT_FOUND', `bullet not found or deleted: ${bulletId}`)
  }

  // 1) Retire stale PENDING suggestions for this bullet.
  const retiredPendingIds: string[] = []
  for (const s of listSuggestionsByBullet(deps.db, bulletId)) {
    if (s.status === 'pending') {
      rejectSuggestion(deps.db, s.id)
      retiredPendingIds.push(s.id)
    }
  }

  // 2) Re-extract the (edited) bullet.
  const snapshot = buildSnapshot(deps, bullet.owner_id)
  const candidates = await extractCandidates(deps, bullet.text, snapshot)
  const { suggestions: drafts } = resolveCandidates(candidates, snapshot, deps.config)

  // 3) Reconcile creates against applied entities from this bullet.
  const applied = collectAppliedEntities(deps, bulletId)
  // Track which applied entities got matched (so the rest are retired in step 4).
  const matchedEntityIds = new Set<string>()
  const keptEntityIds: string[] = []
  const newSuggestionIds: string[] = []
  const appliedIds: string[] = []
  const failedAutoApplyIds: string[] = []

  for (const draft of drafts) {
    const key = draftKey(draft)

    // A 'create' that matches an existing applied entity (same kind + key) → KEEP, do not dupe.
    if (key) {
      const match = applied.find(
        (e) => e.kind === key.kind && e.key === key.key && !matchedEntityIds.has(e.id),
      )
      if (match) {
        matchedEntityIds.add(match.id)
        keptEntityIds.push(match.id)
        continue
      }
    }

    // Otherwise persist as a new suggestion (with provenance) and auto-apply if 'auto'. Same
    // fail-soft persist→apply policy as the main pipeline (shared `persistAndAutoApply`): a stale
    // auto-apply leaves the suggestion pending and is surfaced in failedAutoApplyIds, not swallowed.
    // (destructure as autoApplied/autoFailed — `applied` is already the applied-entities list.)
    const {
      id,
      applied: autoApplied,
      failed: autoFailed,
    } = persistAndAutoApply(deps, draft, bullet.owner_id, bullet.id)
    newSuggestionIds.push(id)
    if (autoApplied) appliedIds.push(id)
    if (autoFailed) failedAutoApplyIds.push(id)
  }

  // 4) Retire applied entities from this bullet that matched NO new create.
  const retiredEntityIds: string[] = []
  for (const entity of applied) {
    if (!matchedEntityIds.has(entity.id)) {
      entity.softDelete()
      retiredEntityIds.push(entity.id)
    }
  }

  return {
    retiredPendingIds,
    newSuggestionIds,
    appliedIds,
    failedAutoApplyIds,
    keptEntityIds,
    retiredEntityIds,
  }
}
