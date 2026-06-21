# @bullet/db

Drizzle ORM (SQLite via `better-sqlite3`) schema, Drizzle Kit migrations, and the typed
**repositories** that are the only sanctioned way to touch the database — including the
apply/commit operations (`applySuggestion`, `softDelete`, `acceptSuggestion`, …).

Schema is written to stay **Postgres-portable**: `text` UUIDs, epoch-ms integer timestamps,
no SQLite-only behaviors. Depends on `@bullet/core`. See the root
[`CLAUDE.md`](../../CLAUDE.md).

> Task 0 shell — the real implementation lands in Task 2.
