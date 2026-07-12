/**
 * The app router — the single tRPC v11 router the server mounts and the web client types
 * against. Every sub-router's procedures are thin (~10-line) wrappers over @bullet/core /
 * @bullet/db / @bullet/agent.
 */

// NOTE(review): a generic `crudRouter` factory collapsing the four entity routers
// (tasks/trackers/trackerEntries/activities) was evaluated and REJECTED — see REVIEW-BACKLOG.md.
// The variation isn't uniform (trackerEntries omits tracker_id; trackers rebuild input from
// ZodEffects), there are only four call sites, and four explicit thin wrappers are the rubric's
// ideal. Do not re-propose it. Revisit only if a fifth/sixth entity lands.

import { router } from '../trpc'
import { activitiesRouter } from './activities'
import { bulletsRouter } from './bullets'
import { suggestionsRouter } from './suggestions'
import { systemRouter } from './system'
import { tasksRouter } from './tasks'
import { trackerAnalyticsRouter } from './trackerAnalytics'
import { trackerEntriesRouter } from './trackerEntries'
import { trackersRouter } from './trackers'
import { weeklyRouter } from './weekly'

export const appRouter = router({
  system: systemRouter,
  bullets: bulletsRouter,
  suggestions: suggestionsRouter,
  tasks: tasksRouter,
  trackers: trackersRouter,
  trackerEntries: trackerEntriesRouter,
  trackerAnalytics: trackerAnalyticsRouter,
  activities: activitiesRouter,
  weekly: weeklyRouter,
})

/** The router TYPE the web client imports for end-to-end type-safety. */
export type AppRouter = typeof appRouter
