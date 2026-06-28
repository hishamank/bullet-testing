/**
 * Entity types for the web client, inferred end-to-end from the server's `AppRouter` via the
 * typed tRPC client. We import the router TYPE only (erased at build) and derive each entity from
 * its query's output — so the web app stays "tRPC client only" (no `@bullet/*` domain imports)
 * while keeping full type-safety with the schemas in `@bullet/core`.
 */

import type { AppRouter } from '@bullet/server'
import type { CreateTRPCClient } from '@trpc/client'

type Client = CreateTRPCClient<AppRouter>

/** The awaited output of a query procedure on the typed client. */
type QueryOutput<T> = T extends { query: (...args: never[]) => Promise<infer R> } ? R : never

export type Bullet = QueryOutput<Client['bullets']['list']>[number]
export type Task = QueryOutput<Client['tasks']['list']>[number]
export type Tracker = QueryOutput<Client['trackers']['list']>[number]
export type TrackerEntry = QueryOutput<Client['trackerEntries']['list']>[number]
export type Activity = QueryOutput<Client['activities']['list']>[number]
export type Suggestion = QueryOutput<Client['suggestions']['listPending']>[number]

/** Closed unions, taken straight from the inferred entity fields (single source of truth). */
export type TaskStatus = Task['status']
export type TaskPriority = NonNullable<Task['priority']>
export type TargetKind = Suggestion['target_kind']
export type SuggestionTier = Suggestion['tier']
export type SuggestionOperation = Suggestion['operation']
export type SuggestionPayload = Suggestion['payload']
export type TrackerInputType = Tracker['input_type']
