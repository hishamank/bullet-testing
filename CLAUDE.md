# CLAUDE.md — Bullet Journal (Foundation & Brain)

This file is the inherited context for every session (human or agent) working in this
repo. Read it fully before making changes. Sections 1, 3, 4, 5 are reproduced from the
project brief. The final section records the **locked engineering decisions** made in
Task 0 — follow them exactly so the codebase stays consistent.

---

## 1. Project context (what we are building)

A **local-first bullet-journal app**. The user brain-dumps thoughts one bullet at a time
into a message-style input (like a chat where *no one replies*). After each bullet, a
**local LLM agent** classifies it and extracts structured productivity entities — tasks,
trackers, activities (and later habits, goals, notes, events) — and proposes them as
**suggestions** the user confirms. High-confidence, low-stakes suggestions auto-apply;
ambiguous ones queue for review.

It runs entirely on the user's machine against a local model (via Ollama). Privacy-first;
the journal is intimate data.

**This task builds the engine, not the cockpit.** The UI is built separately (by a design
tool) and is out of scope here.

**The base entity set for v1 is exactly four types:** `Bullet`, `Task`, `Tracker`,
`Activity`. Do **not** implement Habit, Goal, Note, Event, Collection, or the Planner —
they come later, one at a time.

---

## 3. Tech stack & global conventions

- **Package manager:** pnpm. **Monorepo:** Turborepo. **Language:** TypeScript, `strict: true`.
- **DB:** SQLite via **Drizzle ORM** (`better-sqlite3` driver), **Drizzle Kit** for
  migrations. **Write the schema to stay Postgres-portable** (a hosted multi-user future):
  use `text` for UUID columns, store timestamps consistently (epoch ms integer — see
  locked decisions), avoid SQLite-only behaviors.
- **API transport:** **tRPC v11**, validated with **Zod**.
- **Agent / LLM:** **all-TypeScript.** Talk to **Ollama** over HTTP. Fuzzy/alias matching
  with a small library (e.g. Fuse.js). Embeddings via Ollama's embedding endpoint.
  (A Python sidecar is a *future* escape hatch — do not build it.)
- **Tests:** **Vitest** in every package. **Mock the Ollama client in tests** — CI must
  not require a live model.
- **Lint/format:** Biome (one fast tool for lint + format).
- **IDs:** UUID v4 (`crypto.randomUUID()`), as `text`.
- **Node:** pinned LTS via `.nvmrc` and `engines`.
- **Commits:** Conventional Commits.

### The one non-negotiable architectural rule

**Business logic lives in packages; the framework stays thin.** All DB access, the
apply/commit engine, and the agent pipeline live in `core` / `db` / `agent` as plain
functions. tRPC procedures and any Next code are **~10-line wrappers** that call them.
Never put business logic in Next Server Actions or inside tRPC procedures. A reviewer must
reject any PR that violates this.

### Universal data conventions (every persisted entity)

- `id: text` (UUID)
- `owner_id: text` (FK → users) — **on every top-level entity**, even though v1 is
  single-user. This is cheap insurance for multi-user later.
- `created_at`, `updated_at`
- `state: 'active' | 'deleted'` — **soft delete only; never hard-delete.**
- `source_bullet_id: text | null` (FK → bullets) — **provenance.** Every record/entity must
  be traceable to the bullet that produced it (null only for bullets themselves and for
  manually-created entities).

---

## 4. Domain model (build this correctly)

### 4.1 The definition ↔ record axis

Most concepts split into a **definition** (persistent, created once) and a **record** (a
timestamped instance logged against it). In the base set:

- **Tracker** (definition) → **Tracker Entry** (record).
- **Activity** is a record on its own (a thing the user did); it may *link* to a Tracker
  (becomes a quantified entry) or stay free/unlinked.

This axis is also the **create-vs-append** decision: *append* = add a record to an existing
definition / mutate an existing instance; *create* = mint a new definition or standalone
instance.

### 4.2 The base entities

- **Bullet** — the atomic input unit; the raw text the user typed + timestamp. The stream
  of bullets **is** the journal. Editable (edits re-run extraction); soft-deletable. Source
  of truth / provenance anchor for everything.
- **Task** — an actionable. `status: 'todo' | 'in_progress' | 'done' | 'migrated' |
  'cancelled'`. Optional: `due_at`, `priority` (P1–P4), `notes`. (Projects/subtasks/
  recurrence are later.)
- **Tracker** — a *definition* of something measured. `input_type: 'scale' | 'number' |
  'single_select' | 'multi_select' | 'boolean' | 'text'`, plus config (e.g. scale min/max,
  select options).
- **Tracker Entry** — a *record*: a value logged against a Tracker at a time.
- **Activity** — a *record*: anything the user **did** (ran, smoked, meditated). Optional
  link to a Tracker. Unlinked activities are kept and later feed pattern detection. (Note:
  mood/weight/sleep are **not** activities — they are Tracker Entries on scale/number
  trackers. The action-vs-reading distinction is carried by the Tracker's `input_type`, not
  a separate entity.)

### 4.3 The extraction envelope — `Suggestion` (first-class, persisted)

Every agent extraction becomes a **Suggestion** the user confirms:

- `id`, `owner_id`, `source_bullet_id`
- `target_kind` — which entity/record type this proposes (`task` | `tracker` |
  `tracker_entry` | `activity` | ...)
- `operation` — `'create' | 'append' | 'update'`
- `target_id: text | null` — the existing entity for append/update (null for create)
- `payload: json` — the proposed fields (validated against that kind's Zod schema)
- `confidence: number` (0–1)
- `tier: 'auto' | 'suggest' | 'ask'` — the behavior (see 4.5)
- `status: 'pending' | 'accepted' | 'edited' | 'rejected'`
- `created_at`, `resolved_at: number | null`

**Suggestions persist until accepted or rejected — they never auto-expire.** Pending ones
are reachable via a list and (later) a weekly digest.

### 4.4 Create-vs-append logic (the agent's core decision)

Two orthogonal signals:

1. **Existence check** (decides create vs append): does a matching definition or open
   instance already exist? → resolution/matching layer.
2. **Tense / time-orientation** (decides log vs plan): retrospective (something happened → a
   record) vs prospective (intended → a task or definition).

Routing per bullet segment:

- **Happened (action/state)** → create a **record** unconditionally → match against existing
  definitions/instances → link if confident, else leave unlinked. ("Activity-first": never
  lose data to indecision.)
- **Future, one-off** → a **Task** (or Event, later).
- **Future, recurring** → a **definition** (Habit/Tracker) — but see 4.5.
- **Durable fact** → a Note/entity-file (later).

"Append" has two flavors the resolver must handle: **log under a definition** (run → tracker
entry) and **mutate an existing instance** ("called the dentist" → mark that Task done). So
matching looks at open **instances**, not just definitions.

### 4.5 Confidence tiers & the definition rule

- `tier` is **auto / suggest / ask** — surface the behavior, not a raw number to users.
- **Records/logs** may be `auto` when confident and cheap.
- **Definitions** (Tracker now; Habit/Goal later) are **never `auto`** — creating a
  definition always requires user confirmation, regardless of confidence (`suggest`/`ask`
  only). Eagerness scales inversely with permanence.

### 4.6 Deletion semantics

The delete dialog offers three choices (the agent/back-end must support all):

- **Cancel** — no-op.
- **Delete + extractions** → **cascade**: the bullet and everything traced to it via
  `source_bullet_id` are soft-deleted together (`state = 'deleted'`).
- **Delete but keep extractions** → the bullet is soft-deleted; its extractions survive as
  standalone entities, their `source_bullet_id` now pointing at a deleted bullet.

### 4.7 Editing semantics

Editing a bullet **drops its previous analysis and re-runs extraction.** Re-processing must
**reconcile** against any already-applied extractions for that bullet (keep matches, add
new, retire removed) — not blindly recreate. Implement a clear reconciliation function;
document the chosen strategy.

---

## 5. Monorepo structure

```
.
├─ CLAUDE.md                 # context for future sessions
├─ package.json              # root, pnpm workspaces + turbo
├─ pnpm-workspace.yaml
├─ turbo.json
├─ tsconfig.base.json
├─ apps/
│  └─ web/                   # Next.js (App Router) — SCAFFOLD ONLY (Task 5)
└─ packages/
   ├─ core/                  # domain types, Zod schemas, apply/commit engine, create-vs-append logic
   ├─ db/                    # Drizzle schema + migrations + repositories
   └─ agent/                 # Ollama client, extraction → resolution → suggestion pipeline, serial queue
```

Dependency direction: `db` → `core`; `agent` → `core` + `db`; tRPC server → `core` + `db` +
`agent`; `web` → tRPC client only.

---

## Locked engineering decisions (Task 0)

These resolve every "pick one and be consistent" choice in the brief. **Do not deviate**
without updating this file.

- **Package manager / monorepo:** pnpm workspaces + Turborepo (Turbo 2.x — config key is
  `tasks`, not `pipeline`).
- **Package scope:** `@bullet/*` (`@bullet/core`, `@bullet/db`, `@bullet/agent`, later
  `@bullet/server`). The web app is the private package `web` under `apps/`.
- **Modules:** every package is ESM (`"type": "module"`). TypeScript
  `module: ESNext`, `moduleResolution: Bundler`, `verbatimModuleSyntax: true`. Because we
  use Bundler resolution + tsup, **relative imports do NOT need `.js` extensions** — write
  `import { x } from './foo'`. Use `import type { … }` for type-only imports
  (verbatimModuleSyntax enforces this).
- **Build:** each library package builds with **tsup** (`pnpm build` → `tsup`), emitting
  ESM + `.d.ts` to `dist/`. `package.json#exports` points at `./dist/index.js` +
  `./dist/index.d.ts`. Turbo orders builds via `dependsOn: ["^build"]`; `typecheck` and
  `test` also depend on `^build`, so **run `pnpm build` before `pnpm typecheck`/`pnpm test`
  at the workspace root** (Turbo caches it). Within a single package during dev, build its
  workspace deps first.
- **Typecheck:** `tsc --noEmit` per package (tsup owns emit).
- **Run TS directly** (servers, migration scripts, one-off tooling): **tsx**.
- **Tests:** **Vitest** (`vitest run`). Import test helpers explicitly
  (`import { test, expect, vi } from 'vitest'`) — do not rely on globals. **The Ollama
  client is always mocked in tests**; CI never needs a live model.
- **Lint/format:** **Biome** (`biome check .` for lint, `biome format --write .` to format).
  Single quotes, semicolons as-needed, 2-space indent, 100 col.
- **IDs:** `crypto.randomUUID()` (UUID v4), stored as `text`.
- **Timestamps — CANONICAL:** **epoch milliseconds as an integer** (TypeScript `number`),
  used for **every** timestamp column (`created_at`, `updated_at`, `due_at`, `resolved_at`,
  entry timestamps, …). This overrides any `text` shown in the brief's illustrative type
  sketches. Postgres-portable as `bigint`. Drizzle: `integer('created_at')` (store the ms
  number directly; do not use SQLite-only date functions).
- **Soft delete only:** `state: 'active' | 'deleted'`. Never hard-delete domain rows.
- **Provenance:** every extracted entity carries `source_bullet_id` (nullable; null only for
  bullets themselves and manually-created entities).
- **Node:** 24 (LTS), pinned in `.nvmrc` + `engines`.
- **Commits:** Conventional Commits (`feat:`, `fix:`, `chore:`, `test:`, `docs:`, …).

### The architectural rule, restated for reviewers

Business logic lives in `core` / `db` / `agent` as plain functions. tRPC procedures and any
Next code are thin (~10-line) wrappers. **Reject any PR that puts DB access, the
apply/commit engine, or the agent pipeline inside a framework wrapper.**
