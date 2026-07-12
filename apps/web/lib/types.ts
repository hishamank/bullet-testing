/**
 * Entity types for the web client, inferred end-to-end from the server's `AppRouter` via the
 * typed tRPC client. We import the router TYPE only (erased at build) and derive each entity from
 * its query's output — so the web app stays "tRPC client only" (no `@bullet/*` domain imports)
 * while keeping full type-safety with the schemas in `@bullet/core`.
 */

import type { AppRouter } from '@bullet/server'
import type { CreateTRPCClient } from '@trpc/client'

type Client = CreateTRPCClient<AppRouter>

/**
 * The awaited output of a query procedure on the typed client.
 *
 * Deliberate substitute for tRPC's `inferRouterOutputs<AppRouter>`: that helper lives in
 * `@trpc/server`, which `web` does not depend on (only `@trpc/client` + the tanstack adapter).
 * Rather than pull `@trpc/server` in just for a type, we read the output off the client's
 * query-proc decoration (`{ query }`). If `web` ever takes a `@trpc/server` dep, switch to
 * `inferRouterOutputs` — it reads straight off the router definition and is version-sturdier.
 */
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
export type SuggestionPayload = Suggestion['payload']
