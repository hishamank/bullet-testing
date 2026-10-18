# CLAUDE.md — Bullet Journal (mobile-first)

Inherited context for every session (human or agent) working in this repo. Read it fully before
making changes. Product decisions are recorded on the Notion project page ("Mobile audit and
functionality plan", 2026-10-18). The pre-restructure web-first code lives at the git tag
`legacy-v0` — consult it for prior art, never copy it wholesale.

---

## 1. Product

A **mobile-first, offline-first bullet journal**. The user opens the phone, types or speaks a
thought, taps Send, and moves on. Capture never waits on classification.

- The **phone** saves every capture locally first and works with no connection.
- When online, the phone **syncs** with the user's **home server**, which processes bullets
  **asynchronously** with a local LLM (**llama.cpp** `llama-server`) and syncs results back.
- Extractions become **suggestions**. Confident, cheap ones auto-apply; the rest wait for review
  later. The app never turns capture into a form or a chat.
- **iOS first** (tested on a real iPhone). Android stays possible through Expo but is not a
  first-slice target. The **web** app is a secondary client (review, dashboards).
- Privacy-first: journal text stays on the user's hardware. Never send it to hosted services.

**First-slice entity set:** `Bullet`, `Task`, `Tracker` / `Tracker Entry`, `Activity`, `Event`.
Habit, Goal, Note, Collection, Planner, recurrence and search come later, one at a time.
**Voice capture is in the first slice.**

## 2. Monorepo

```
apps/
  mobile/     # Expo SDK 57 + Expo Router (Metro). Primary client.
  web/        # Vite + React. Secondary client.
  server/     # Node + Hono on the home machine: sync ingest, queue, LLM, apply.
packages/
  core/       # @bullet/core — domain types + Zod schemas. Pure TS.
  engine/     # @bullet/engine — extraction → resolution, LlmClient interface. Pure TS.
```

Dependency direction: `engine → core`; `server → core + engine`; `mobile` / `web` → `core`
(+ `engine` where useful) and the server's API contract. **`core` and `engine` must stay pure:**
no DB drivers, no `node:*` imports, no React Native APIs — they run on the server, the phone and
the web.

### The one non-negotiable architectural rule

**Business logic lives in packages; the framework stays thin.** HTTP routes, Expo screens and
React components are thin wrappers over package functions. Reject any change that puts domain
rules, matching, apply logic or the extraction pipeline inside a route handler or component.

## 3. Locked engineering decisions

- **Toolchain: Vite+** (`vite-plus`, `vp`). `vp check` = Oxfmt + Oxlint (type-aware) +
  type-check; `vp test` = Vitest; `vp run -r <task>` = workspace task runner (replaces Turbo);
  `vp build` / `vp dev` for the web app. Root `vite.config.ts` owns lint/fmt config — do not add
  per-package `lint`/`fmt` blocks.
- **Package manager:** pnpm workspaces with a catalog in `pnpm-workspace.yaml`. Shared versions
  go in the catalog and are referenced as `"catalog:"`. `vite` is overridden to
  `@voidzero-dev/vite-plus-core`.
- **Mobile bundling stays on Metro.** Run Expo via its own CLI (`expo start`, `expo run:ios`,
  EAS). Never `vp dev`/`vp build` the mobile app. Add Expo deps with `npx expo install`.
  Speech recognition and other native modules need a **dev build**, not Expo Go.
- **Internal packages are source-only:** `exports` points at `./src/index.ts`; no build step.
  Metro, Vite, Vitest and tsx all consume TS source directly.
- **Modules:** ESM everywhere, `moduleResolution: Bundler`, `verbatimModuleSyntax`. Relative
  imports are **extensionless**. Use `import type` for type-only imports.
- **Tests:** import from `vite-plus/test` (lint-enforced), never `vitest`. **The LLM client is
  always mocked** (`createScriptedLlmClient`); CI never needs a live model.
- **Format:** single quotes, no semicolons, 2-space indent, 100 columns (Oxfmt).
- **LLM:** depend on the `LlmClient` interface in `@bullet/engine`. The production adapter is
  `createOpenAiCompatibleClient` targeting `llama-server`'s `/v1/chat/completions` with
  `response_format: json_schema`. No Ollama, no hosted LLM.
- **Server:** binds `127.0.0.1` by default; expose to the phone deliberately (e.g. Tailscale)
  and never without auth.
- **IDs:** UUID v4 (`crypto.randomUUID()`), generated **on the client** so sync is idempotent.
- **Timestamps:** epoch **milliseconds** as integers everywhere.
- **Soft delete only:** `state: 'active' | 'deleted'`. Never hard-delete domain rows.
- **Provenance:** every extracted entity carries `source_bullet_id`.
- **Node:** 24 LTS (`.nvmrc`, `engines`). **Commits:** Conventional Commits.

## 4. Domain model

### 4.1 Definition ↔ record

Most concepts split into a **definition** (persistent) and a **record** (a timestamped instance
logged against it): **Tracker → Tracker Entry**. An **Activity** is a record of something the
user did; it may link to a Tracker or stay unlinked (unlinked activities feed later pattern
detection). Mood/weight/sleep are Tracker Entries, not activities. This axis is also the
**create-vs-append** decision.

### 4.2 Entities

- **Bullet** — the raw captured text (typed or transcribed) + timestamp. The stream of bullets
  is the journal and the provenance anchor. Carries a **processing status** the UI can show:
  saved on device → synced → processing → processed / needs review / failed (retryable).
- **Task** — `status: todo | in_progress | done | migrated | cancelled`; optional `due_at`,
  `priority` (P1–P4), `notes`.
- **Tracker** — `input_type: scale | number | single_select | multi_select | boolean | text`
  plus config. **Tracker Entry** — a value logged against a tracker at a time.
- **Activity** — something the user did; optional tracker link.
- **Event** — something that happens to the user at a time (start, optional end). Recurrence is
  later. Distinct from Task (you do it) vs Event (it happens).

### 4.3 Suggestion (persisted)

`id`, `owner_id`, `source_bullet_id`, `target_kind`, `operation: create | append | update`,
`target_id | null`, `payload` (validated against the kind's schema), `confidence` (0–1),
`tier: auto | suggest | ask`, `status: pending | accepted | edited | rejected`, `created_at`,
`resolved_at`. **Suggestions never expire.**

### 4.4 Create vs append

Two orthogonal signals: **existence** (does a matching definition / open instance exist?) and
**tense** (happened → record; future one-off → Task or Event; future recurring → definition).
Anything that happened produces a record unconditionally ("activity-first"). Append has two
flavors: log under a definition, and mutate an existing instance ("called the dentist" → mark
that task done). Candidate generation is deterministic (exact / token / Fuse.js); the LLM
chooses among candidates.

### 4.5 Tiers

Show tiers, not raw numbers. **Definitions are never `auto`.** Value-bearing and state-derived
records are capped at `suggest` unless explicitly enabled. Accepting a deferred suggestion
re-validates against current state.

### 4.6 Delete and edit

Delete offers Cancel / Delete + extractions (cascade soft-delete) / Delete but keep extractions.
Editing a bullet re-runs extraction and must **reconcile** with what was already applied (keep
matches, add new, retire removed) — extract first, then retire, in one transaction.

## 5. Known issues in ported code (fix in the relevant slice)

The audit of `legacy-v0` found these; `core` and `engine` were ported with tests but unfixed:

- Extraction prompt has no current date/timezone, so relative dates can't resolve — required
  now that Events are in slice 1.
- A matched scale/number tracker with no value defaults to 0 and clamps to the scale minimum
  (`resolve.ts` `coerceEntryValue`).
- Mark-done UPDATE payloads carry a snapshot of the task's fields; the new apply engine must
  patch only changed fields.
- A strong containment match can auto-apply "mark done" on an open task — revisit the tier.
- `occurred_at` / `logged_at` default to processing time, not the bullet's capture time.
