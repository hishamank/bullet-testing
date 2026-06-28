# @bullet/server

tRPC v11 router + the **standalone local Node server**. Every procedure is a thin (~10-line)
wrapper over `@bullet/core` / `@bullet/db` / `@bullet/agent` — **no business logic lives here**
(no DB access, no apply/commit engine, no agent pipeline; those stay in the packages). The package
exports the `AppRouter` **type** for the web client and **boots the agent queue worker on start**
(the "always a local server" piece — it runs without Next).

## Architecture

- `src/trpc.ts` — `initTRPC.context<Context>().create()`; exports `router`, `publicProcedure`,
  and `createCallerFactory` (used by the integration tests). No auth in v1 (single-user, local).
- `src/context.ts` — the `Context` = the singleton deps `{ db, ollama, config, emitter, runtime,
  ownerId }`. Deps are built **once**: `buildServerContext()` wires the real ones (opens the db,
  constructs the `HttpOllamaClient`, builds the `AgentRuntime`); `createServerDeps(...)` lets tests
  inject a `createTestDb` + a scripted Ollama. A request context **is** the deps bundle (no
  per-request state).
- `src/owner.ts` — `getOrCreateDefaultOwner(db)` resolves the single v1 owner id (ensures one user
  row exists), used as `owner_id` for every procedure.
- `src/config.ts` — `loadServerConfig(env)`: the HTTP/process knobs (PORT, DATABASE_PATH,
  CORS_ORIGIN) plus the embedded agent config (delegated to `loadAgentConfig` — one source of truth
  for Ollama/model/threshold settings).
- `src/routers/*` — the sub-routers; `src/routers/index.ts` assembles `appRouter` and exports
  `AppRouter`.
- `src/sse.ts` — the Server-Sent-Events bridge from the agent emitter to the browser.
- `src/app.ts` — `createApp(deps)`: the Hono app (CORS + `/trpc` + `/events` + `/health`).
- `src/server.ts` — `startServer()`: the standalone entry (opens db, starts the worker, serves).

## Procedures (all thin wrappers)

- **system** — `health` → `{ ok: true, now }`; `echo({ message })` → `{ message }` (a query, so
  called over GET; used by the Task 5 web scaffold to round-trip).
- **bullets** — `create({ text })` (creates the bullet, then `runtime.enqueueExtraction`),
  `list`, `get({ id })`, `update({ id, text })` (updates then `runtime.reprocessBullet` — §4.7),
  `delete({ id, mode })` with `mode: 'cancel' | 'cascade' | 'keep'` (`softDelete` — §4.6).
- **suggestions** — `listPending` (owner-scoped pending), `accept({ id })` (`acceptSuggestion`),
  `reject({ id })` (`rejectSuggestion`), `edit({ id, payload })` (`editSuggestion` — §4.7).
- **tasks / trackers / trackerEntries / activities** — `list` + `create` / `update` / `delete`
  (owner-scoped CRUD). Inputs are validated with the `@bullet/core` insert schemas (via the
  `src/routers/inputs.ts` client-view schemas); `create` injects `owner_id` from the context and
  `source_bullet_id: null` (manually-created entities have no provenance bullet).

The bullet→extraction→suggestion→accept flow is **not** driven inside a procedure: `bullets.create`
only enqueues a job; the serial worker (started by `server.ts`) runs the
extraction → resolution → suggestion pipeline (auto-applying `auto`-tier records), and `suggestions.*`
just calls the `@bullet/db` apply engine.

## SSE — streaming extraction events

`GET /events` opens an `text/event-stream` that subscribes to the agent emitter and re-broadcasts:

- `extraction:complete` — `{ jobId, bulletId, suggestionIds, appliedIds, failedAutoApplyIds }`
- `extraction:error` — `{ jobId, bulletId, error }`

Each is written as an SSE frame (`event:` + JSON `data:`). The emitter listeners are detached when
the client disconnects (stream abort), so a long-lived page never leaks subscriptions. The route is
pure transport — it runs no pipeline code, only mirrors events the worker already emits, and is
testable in-process via `app.request('/events')`.

## Running the standalone server

```bash
# from the repo root — build the workspace deps first (turbo: core → db → agent → server)
pnpm build

# run it (tsx, no Next):
pnpm --filter @bullet/server start      # tsx src/server.ts
pnpm --filter @bullet/server dev        # tsx watch src/server.ts
```

On start it: loads config, `createDb(DATABASE_PATH, { migrate: true })`, builds an
`HttpOllamaClient`, `createAgentRuntime`, ensures the default owner, mounts `createApp(deps)`,
**starts the worker** (`runtime.worker.start()`), and serves via `@hono/node-server`. `SIGINT` /
`SIGTERM` stop the worker and close the db (graceful shutdown). A live Ollama is only needed once
a bullet is actually extracted; `/health` and CRUD work without it.

### Environment variables

| Var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3001` | HTTP port for the standalone server. |
| `DATABASE_PATH` | `./bullet.db` | SQLite file (migrated on open). |
| `CORS_ORIGIN` | `http://localhost:3000` | Allowed browser origin for `/trpc` + `/events`. |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama endpoint (via `loadAgentConfig`). |
| `OLLAMA_LIVE_MODEL` | `gemma3:4b` | Interactive extraction model. |
| `OLLAMA_WEEKLY_MODEL` | `gemma3:4b` | Weekly-analysis model. |
| `AGENT_AUTO_THRESHOLD` | `0.85` | Confidence at/above which a record/update is `auto`. |
| `AGENT_SUGGEST_THRESHOLD` | `0.5` | Confidence at/above which a suggestion is at least `suggest`. |
| `AGENT_AUTO_CREATE_TASKS` | `false` | When false, task creates are capped at `suggest`. |

## The web client

The web app imports only the **type**:

```ts
import type { AppRouter } from '@bullet/server'
```

It never imports the server's runtime code (dependency direction: `web` → tRPC client only).

## Tests

Vitest, with the Ollama client **always mocked** (`createScriptedOllamaClient`) — CI never needs a
live model, and nothing binds a socket:

- `integration.test.ts` — the key end-to-end run via `createCallerFactory(appRouter)`:
  `bullets.create` → `worker.drain()` → the `auto` activity is auto-applied and the `suggest` task
  is pending → `suggestions.accept` → the task entity exists with `source_bullet_id` provenance;
  plus `reject` / `edit`.
- `app.test.ts` — `/health`, a `/trpc` round-trip, and the `/events` SSE stream (drain a job, read
  the `extraction:complete` frame, assert the ids).
- `crud.test.ts` — representative CRUD round-trips for tasks/trackers/trackerEntries/activities and
  `bullets.delete` cascade vs keep.
- `config.test.ts` — `loadServerConfig` env parsing and `getOrCreateDefaultOwner` idempotence.

```bash
pnpm --filter @bullet/server test
```
