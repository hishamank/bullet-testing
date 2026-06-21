# @bullet/core

Domain types, Zod schemas (insert & select variants), the apply/commit engine, and the
create-vs-append logic for the bullet-journal base entity set (`Bullet`, `Task`, `Tracker`,
`TrackerEntry`, `Activity`, `Suggestion`, `User`).

**Pure package:** types/schemas + small pure helpers only. No DB, no IO, no network. See the
root [`CLAUDE.md`](../../CLAUDE.md) for conventions and the domain model.

> Task 0 shell — the real implementation lands in Task 1.
