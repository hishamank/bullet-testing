/**
 * enqueueExtraction — the helper `bullets.create` calls to schedule extraction for a freshly-created
 * bullet. It enqueues an `extract_bullet` job (consumed by the serial worker) carrying the bullet id
 * (and owner for scoping); the worker does the heavy lifting later.
 *
 * The RETRY path (`bullets.reprocess`) reuses this with `{ reconcile: true }`: the SAME job type,
 * but the worker routes it through `reprocessBullet` so a retry is idempotent (see process.ts).
 */

import { enqueueJob, type Job } from '@bullet/db'
import type { AgentDeps } from '../deps'
import { EXTRACT_BULLET_JOB } from './worker'

/** Optional behavior for the enqueued job. */
export interface EnqueueExtractionOpts {
  /** Process as a RECONCILE (idempotent retry) rather than a blind first-pass extraction. */
  reconcile?: boolean
}

/** Enqueue an extraction job for `bulletId` owned by `ownerId`. Returns the queued job. */
export function enqueueExtraction(
  deps: Pick<AgentDeps, 'db'>,
  bulletId: string,
  ownerId: string,
  opts?: EnqueueExtractionOpts,
): Job {
  return enqueueJob(deps.db, {
    type: EXTRACT_BULLET_JOB,
    owner_id: ownerId,
    // A reconcile retry carries the flag the worker branches on; the create path omits it.
    payload: opts?.reconcile ? { bulletId, reconcile: true } : { bulletId },
  })
}
