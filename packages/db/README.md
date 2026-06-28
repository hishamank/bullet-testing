# @bullet/db

Drizzle ORM (SQLite via `better-sqlite3`) schema, Drizzle Kit migrations, and the typed
**repositories** plus the **apply/commit engine** — the only sanctioned way to touch the
database. Depends ONLY on `@bullet/core` (never on `@bullet/agent`). All business logic lives
here as plain functions; a future tRPC layer is a thin (~10-line) wrapper. See the root
[`CLAUDE.md`](../../CLAUDE.md).

## Postgres-portability

The schema is written to survive a future move to hosted Postgres:

- **ids / FKs** are `text` columns (UUID v4 via `crypto.randomUUID()`) — never integer, never
  `AUTOINCREMENT`.
- **timestamps** are `integer` columns holding **epoch milliseconds** as a plain number
  (matching `@bullet/core`'s `number` type). We store the ms number directly — not
  `{ mode: 'timestamp' }` (seconds/`Date`) and never SQLite date functions. (Postgres:
  `bigint`.)
- **enums** are `text` columns with `{ enum: [...] }` mirroring the `@bullet/core` unions.
- **JSON** columns (`trackers.config`, `tracker_entries.value`, `suggestions.payload`,
  `jobs.payload`) are `text({ mode: 'json' }).$type<...>()` with the matching core type.
  (Postgres: `jsonb`.)
- **indexes** — `source_bullet_id` is indexed on `tasks`, `trackers`, `tracker_entries`,
  `activities`, and `suggestions` (the cascade soft-delete filters on it). Drizzle `index()`,
  portable to Postgres.

The driver enforces `PRAGMA foreign_keys = ON`.

## Schema (`src/schema.ts`)

Eight tables. Domain entities carry the universal columns `id`, `owner_id` (FK → `users`),
`created_at`, `updated_at`, `state` (`'active' | 'deleted'`), and — on extracted entities —
`source_bullet_id` (FK → `bullets`, provenance).

| Table             | Notes |
| ----------------- | ----- |
| `users`           | Owner root. No `owner_id`, no `source_bullet_id`, no `state`. |
| `bullets`         | The atomic input + provenance anchor. No `source_bullet_id`. |
| `tasks`           | `status`, `title`, `notes?`, `due_at?`, `priority?`. |
| `trackers`        | Definition: `name`, `input_type`, `config` (json). |
| `tracker_entries` | Record: `tracker_id` (FK), `value` (json), `logged_at`. |
| `activities`      | Record: `name`, `occurred_at`, `tracker_id?` (FK), `notes?`, `quantity?`, `unit?`. |
| `suggestions`     | Extraction envelope. `source_bullet_id` NON-null. `target_id` is **polymorphic** across kinds, so it carries **no FK**. |
| `jobs`            | Serial queue. No soft-delete `state`; its lifecycle is `status` (`queued → running → done \| failed`). `owner_id` nullable. |

## Client (`src/client.ts`)

```ts
import { createDb, createTestDb, runMigrations, migrationsFolder } from '@bullet/db'

const { db, sqlite } = createDb('./bullet.db', { migrate: true, wal: true })
const { db } = createTestDb() // in-memory + migrations applied (tests)
runMigrations(db) // apply pending migrations to an open db
```

`migrationsFolder` is resolved relative to the module via
`fileURLToPath(new URL('../drizzle', import.meta.url))`, so it points at `packages/db/drizzle`
from both `src/` (vitest) and `dist/` (the built bundle). The server's DB path comes from
`DATABASE_PATH` via `databasePathFromEnv()`; `createDb` itself takes an explicit `url` so tests
can pass `':memory:'`.

## Repositories (`src/repositories/*.ts`) — the only DB access

Per entity (`users`, `bullets`, `tasks`, `trackers`, `trackerEntries`, `activities`,
`suggestions`): `create` / `getById` / `list` / `update` / `softDelete`.

- **`create`** mints `id` via `crypto.randomUUID()`, sets `created_at = updated_at = Date.now()`
  and `state = 'active'`, **validates input with the matching `@bullet/core` INSERT schema**
  (throwing a typed `DbError('INVALID_PAYLOAD', …)`), and returns the inserted row.
- **`list`** is owner-scoped and excludes soft-deleted rows by default
  (`{ includeDeleted: true }` to include them).
- **`update`** bumps `updated_at`; never touches `id` / `owner_id` / `created_at` /
  `source_bullet_id`.
- **`softDelete`** sets `state = 'deleted'` and bumps `updated_at` (the bullet-level cascade
  lives in the apply engine).

The extracted entities (`tasks`, `trackers`, `trackerEntries`, `activities`) also expose a
`list…BySourceBullet(db, bulletId)` helper returning the **active** rows traced directly to one
bullet (mirroring `listSuggestionsByBullet`). These push the
`source_bullet_id = ? AND state = 'active'` predicate to SQL (indexed) and back the cascade
soft-delete, so it is O(rows traced to that bullet) rather than O(all of the owner's rows).

The **jobs** repo exposes `enqueueJob`, `claimNextJob` (queued → running, oldest first — for the
future serial worker), `markJobDone`, `markJobFailed(error)`, `getJobById`, `listJobsByStatus`.
`claimNextJob` / `listJobsByStatus` order by `(created_at, id)` for a deterministic tiebreak.

## Apply / commit engine (`src/apply.ts`) — the heart

A `Suggestion` is the agent's proposed change (CLAUDE.md §4.3). The engine executes it against
**current** state, **re-validating** the payload each time (suggestions persist; state may have
moved since extraction).

### `applySuggestion(db, suggestionOrId)`

1. Load the suggestion; require `state = 'active'` **and** `status = 'pending'` (typed
   `DbError('INVALID_STATE', …)` otherwise).
2. Re-validate `payload` against the target kind's INSERT schema
   (`validateSuggestionPayload`); reject on failure.
3. Dispatch on `operation`:
   - **`create`** → insert a NEW row of `target_kind` from `payload`, **forcing**
     `owner_id` / `source_bullet_id` from the suggestion (provenance integrity). `target_id`
     must be null.
   - **`append`** → add a child record to the definition at `target_id`. **v1:**
     `target_kind = 'tracker_entry'`, `target_id = <tracker id>` → create a `tracker_entry`
     with `tracker_id = target_id`; the target tracker must **exist and be active**. Other
     append kinds throw `UNSUPPORTED_OPERATION` (the design is extensible).
   - **`update`** → mutate the existing entity at `target_id` (must exist and be active). Only
     **mutable** fields from the payload are applied (never id / owner / provenance /
     `created_at`); `updated_at` is bumped. **v1:** `target_kind = 'task'` (e.g. mark a task
     `done`); other kinds throw `UNSUPPORTED_OPERATION`.

### Resolution wrappers

- **`acceptSuggestion(db, id)`** → guard pending → `applySuggestion` → set
  `status = 'accepted'`, `resolved_at = now`. Returns `{ suggestion, result }`. A failed apply
  (e.g. invalid payload) leaves the suggestion **pending** (not resolved).
- **`rejectSuggestion(db, id)`** → guard pending → `status = 'rejected'`, `resolved_at = now`.
  **Applies nothing** (no entity created/mutated). Returns the suggestion.
- **`editSuggestion(db, id, newPayload)`** → validate `newPayload` for the kind/operation →
  persist `payload = newPayload`, `status = 'edited'` (terminal, accept-with-modifications per
  §4.7), `resolved_at = now` → apply the **edited** payload. Returns `{ suggestion, result }`.

Double-resolving a non-pending suggestion throws `DbError('INVALID_STATE', …)`.

### `softDelete(db, bulletId, mode)` — deletion semantics (§4.6)

- **`'cancel'`** → no-op.
- **`'cascade'`** → soft-delete the bullet AND every active row across
  `tasks` / `trackers` / `tracker_entries` / `activities` / `suggestions` whose
  `source_bullet_id === bulletId` (direct provenance). Returns the affected ids.
- **`'keep'`** → soft-delete ONLY the bullet; its extractions survive (their
  `source_bullet_id` still points at the now-deleted bullet).

All guard failures raise `DbError` with a stable `code`
(`NOT_FOUND` / `INVALID_STATE` / `INVALID_PAYLOAD` / `UNSUPPORTED_OPERATION` / `CONSTRAINT`).

## Migrations

Generated SQL lives in [`drizzle/`](./drizzle) (committed). Regenerate after a schema change:

```sh
pnpm --filter @bullet/db db:generate   # drizzle-kit generate (reads drizzle.config.ts)
```

Apply migrations to the server's `DATABASE_PATH` file (a tsx-runnable script):

```sh
DATABASE_PATH=./bullet.db pnpm --filter @bullet/db db:migrate
```

Tests use `createTestDb()` (in-memory + migrations) and also exercise a real temp file to prove
the generated SQL is valid.

## Verify

```sh
pnpm --filter @bullet/db exec biome check --write .
pnpm build            # turbo: @bullet/core then @bullet/db
pnpm --filter @bullet/db typecheck
pnpm --filter @bullet/db lint
pnpm --filter @bullet/db test
```
