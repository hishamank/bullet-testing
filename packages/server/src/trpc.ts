/**
 * tRPC v11 initialization. This is the ONLY place `initTRPC` is called; everything else builds
 * routers/procedures from the helpers exported here.
 *
 * No auth in v1 (single-user, local-first) — every procedure is `publicProcedure`. The
 * `Context` carries the singleton deps + the resolved owner id; procedures stay thin (~10-line)
 * wrappers that call into @bullet/core / @bullet/db / @bullet/agent.
 */

import { initTRPC } from '@trpc/server'
import type { Context } from './context'

const t = initTRPC.context<Context>().create()

/** Build a router from a procedure map. */
export const router = t.router

/** The (only) procedure builder — no auth middleware in v1. */
export const publicProcedure = t.procedure

/** Build an in-process caller from a context — used by the integration tests. */
export const createCallerFactory = t.createCallerFactory

/** Re-export the middleware builder for completeness (unused in v1). */
export const middleware = t.middleware
