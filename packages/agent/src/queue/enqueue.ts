/**
 * enqueueExtraction — the helper Task 4's `bullets.create` calls to schedule extraction for a
 * freshly-created bullet. It enqueues an `extract_bullet` job (consumed by the serial worker)
 * carrying the bullet id (and owner for scoping); the worker does the heavy lifting later.
 */

import { enqueueJob, type Job } from '@bullet/db'
import type { AgentDeps } from '../deps'
import { EXTRACT_BULLET_JOB } from './worker'

/** Enqueue an extraction job for `bulletId` owned by `ownerId`. Returns the queued job. */
export function enqueueExtraction(
  deps: Pick<AgentDeps, 'db'>,
  bulletId: string,
  ownerId: string,
): Job {
  return enqueueJob(deps.db, {
    type: EXTRACT_BULLET_JOB,
    owner_id: ownerId,
    payload: { bulletId },
  })
}
