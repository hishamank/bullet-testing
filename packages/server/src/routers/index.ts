/**
 * The app router — the single tRPC v11 router the server mounts and the web client types
 * against. Every sub-router's procedures are thin (~10-line) wrappers over @bullet/core /
 * @bullet/db / @bullet/agent.
 */

import { router } from '../trpc'
import { activitiesRouter } from './activities'
import { bulletsRouter } from './bullets'
import { suggestionsRouter } from './suggestions'
import { systemRouter } from './system'
import { tasksRouter } from './tasks'
import { trackerEntriesRouter } from './trackerEntries'
import { trackersRouter } from './trackers'

export const appRouter = router({
  system: systemRouter,
  bullets: bulletsRouter,
  suggestions: suggestionsRouter,
  tasks: tasksRouter,
  trackers: trackersRouter,
  trackerEntries: trackerEntriesRouter,
  activities: activitiesRouter,
})

/** The router TYPE the web client imports for end-to-end type-safety. */
export type AppRouter = typeof appRouter
