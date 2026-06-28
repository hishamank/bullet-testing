'use client'

/**
 * The shared read model for the journal. Fetches the bullet stream plus every extracted entity
 * and the pending suggestions, then derives the lookups the screens need:
 *
 *  - `bulletsById` / `trackersById` — id → row
 *  - `entitiesByBulletId` — applied entities grouped under the bullet they were extracted from
 *    (the provenance thread the design surfaces as "↳ from your journal")
 *  - `pendingByBulletId` — pending suggestions grouped under their source bullet
 *
 * All derivation is presentation-only; the server owns every domain rule.
 */

import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useTRPC } from '@/lib/trpc'
import type { Activity, Bullet, Suggestion, Task, Tracker, TrackerEntry } from '@/lib/types'
import {
  groupBy,
  indexBy,
  type NormalizedEntity,
  normalizeActivity,
  normalizeTask,
  normalizeTrackerEntry,
} from '@/lib/view-model'

export interface JournalData {
  isLoading: boolean
  isError: boolean
  error: unknown
  /** Bullets oldest → newest (stream order). */
  bullets: Bullet[]
  bulletsById: Map<string, Bullet>
  tasks: Task[]
  trackers: Tracker[]
  trackersById: Map<string, Tracker>
  trackerEntries: TrackerEntry[]
  activities: Activity[]
  suggestions: Suggestion[]
  /** Every applied record/entity, normalized for margins & chips. */
  entities: NormalizedEntity[]
  entitiesByBulletId: Map<string, NormalizedEntity[]>
  pendingByBulletId: Map<string, Suggestion[]>
}

export function useJournalData(): JournalData {
  const trpc = useTRPC()
  const bulletsQ = useQuery(trpc.bullets.list.queryOptions())
  const tasksQ = useQuery(trpc.tasks.list.queryOptions())
  const trackersQ = useQuery(trpc.trackers.list.queryOptions())
  const entriesQ = useQuery(trpc.trackerEntries.list.queryOptions())
  const activitiesQ = useQuery(trpc.activities.list.queryOptions())
  const suggestionsQ = useQuery(trpc.suggestions.listPending.queryOptions())

  const queries = [bulletsQ, tasksQ, trackersQ, entriesQ, activitiesQ, suggestionsQ]

  const bullets = useMemo(
    () => [...(bulletsQ.data ?? [])].sort((a, b) => a.created_at - b.created_at),
    [bulletsQ.data],
  )
  const tasks = tasksQ.data ?? []
  const trackers = trackersQ.data ?? []
  const trackerEntries = entriesQ.data ?? []
  const activities = activitiesQ.data ?? []
  const suggestions = suggestionsQ.data ?? []

  const bulletsById = useMemo(() => indexBy(bullets, (b) => b.id), [bullets])
  const trackersById = useMemo(() => indexBy(trackers, (t) => t.id), [trackers])

  const entities = useMemo<NormalizedEntity[]>(() => {
    const out: NormalizedEntity[] = []
    for (const t of tasks) out.push(normalizeTask(t))
    for (const a of activities) out.push(normalizeActivity(a))
    for (const e of trackerEntries) out.push(normalizeTrackerEntry(e, trackersById))
    return out
  }, [tasks, activities, trackerEntries, trackersById])

  const entitiesByBulletId = useMemo(
    () =>
      groupBy(
        entities.filter((e) => e.sourceBulletId),
        (e) => e.sourceBulletId as string,
      ),
    [entities],
  )

  const pendingByBulletId = useMemo(
    () => groupBy(suggestions, (s) => s.source_bullet_id),
    [suggestions],
  )

  return {
    isLoading: queries.some((q) => q.isPending),
    isError: queries.some((q) => q.isError),
    error: queries.find((q) => q.isError)?.error ?? null,
    bullets,
    bulletsById,
    tasks,
    trackers,
    trackersById,
    trackerEntries,
    activities,
    suggestions,
    entities,
    entitiesByBulletId,
    pendingByBulletId,
  }
}
