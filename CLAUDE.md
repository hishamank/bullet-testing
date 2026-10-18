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

**Capture → thoughts → things.** The user can empty their mind: a **capture** (typed or spoken,
kept forever with its audio) is split into **thoughts** (every thought kept, classified), and
**things** (tasks, events, tracker entries, activities) are extracted from the actionable ones as
suggestions. The code and API keep the name `bullet` for a capture.

**First-slice thought kinds:** worry, to_check, question, idea, note, task, event, tracker,
activity. Kinds are classification (no review needed); the user can re-classify (sticky).

**Slices:** 1 = capture, transcribe, store, split into thoughts, classify, extract things,
clarifying questions as data. 2 = reflective questions. 3 = cross-capture connections and
recurring themes. Build gradually; don't pull slice 2/3 forward.

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

### Capture loop (slice 1, 2026-10-18)

- **The contract is `docs/contract.md`** (code: `@bullet/core` `processing.ts` + `sync.ts`). Bullet
  states: `saved_local` (phone only) → `synced` → `processing` → `processed` | `needs_review` |
  `failed` (error code + attempts; always user-retryable). Screens are designed against it:
  change it **additively only** (new ops / new change collections), and update the doc with it.
- **Sync:** `POST /sync/push` (ordered ops, idempotent by client `op_id` and by bullet id) and
  `GET /sync/pull?cursor=` (opaque cursor over a per-entity change log; full rows, soft-deleted
  included). Every server write to a synced entity must call `touch()` in the same transaction.
- **Auth:** one bearer token per device, SHA-256 hashed at rest, required on **every** route
  (`/health` included). Provision with `pnpm --filter server device:add <name>`.
- **Server persistence:** SQLite via **better-sqlite3** + Drizzle (`apps/server/src/db`).
  Chosen over `node:sqlite` because Drizzle's driver for it is RC-only and better-sqlite3's
  synchronous transactions keep reconcile + apply + status atomic. Migrations:
  `pnpm --filter server db:generate`, applied on open. It is a native addon: after switching Node
  versions run `pnpm rebuild better-sqlite3`.
- **Queue:** one durable job per bullet (`jobs` table); retries with backoff, an LLM deadline
  (`withLlmTimeout`), `running` jobs recovered at startup, results discarded if the bullet was
  edited/deleted meanwhile (`text_version`). One job at a time (one model slot).
- **Apply engine** (`apps/server/src/apply`): revalidates against current state at apply time;
  a created entity's id **is** the suggestion id (idempotent); `update` payloads are field-level
  patches validated by `targetKindUpdateSchemas` (never a snapshot); undo restores `before`
  values and refuses (`conflict`) if the user changed the result since.
- **Dates:** the model **quotes** date phrases (`fields.when`); `@bullet/engine` `time/`
  resolves them against the bullet's `captured_at` + IANA `timezone`. The engine never reads the
  clock; records default to capture time.
- **Voice notes keep their audio** (user decision, 2026-10-18). The recording is the source of
  truth, kept permanently on the phone and the server (soft delete only). The phone saves the
  live on-device draft (Apple SpeechAnalyzer) as the bullet text plus a `device_draft`
  transcript. The server re-transcribes in the `transcribing` state, before extraction, through
  the injected `Transcriber` interface (`@bullet/engine`; whisper.cpp later, scripted in tests).
  It stores a `server` transcript, which replaces the bullet text unless `text_edited_by_user`.
  Transcription is multilingual (English, Lebanese Arabic and French mixed): never force a
  language. A voice bullet's job waits (`waiting_audio`) until its recording has fully uploaded.
  Audio upload is `PUT /sync/audio/:id` with an `upload-offset` header: resumable, idempotent by
  attachment id, sha256-verified. Recordings live under `AUDIO_DIR` on the server. Until a
  transcriber is wired, voice bullets are processed on their device draft.
- **Phone data layer** (`apps/mobile/src/data`, `src/sync`): expo-sqlite + Drizzle. Every local
  action writes its change **and** its outbox op in one transaction. Migrations are drizzle-kit
  SQL inlined into `migrations.gen.ts` (`pnpm --filter mobile db:generate`) and applied by a
  driver-agnostic runner, so the same code runs on device and in Vitest (better-sqlite3).
  React Native / Expo APIs live only in `open.ts`, `settings.ts` and `runtime.ts` (which also
  reads recording chunks with expo-file-system); everything else is testable logic. The mobile test script is `pnpm exec vp test` because the app's TypeScript
  (Expo's ~6.x) gives it its own `vite-plus` peer variant.

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
- **Thought** — a segment of a capture: text, span, position, kind, kind_source; provenance
  `source_bullet_id`. Things/suggestions carry `source_thought_id` too.
- **Question** — clarifying (slice 1): topic date | new_tracker | other, options, status
  open | answered | dismissed.

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

### 4.7 Asking the user (deliberate reversal)

The old rule "the agent never asks free-text questions" is reversed, deliberately and narrowly:

- **Clarifying questions** (slice 1): short and concrete, about one ambiguous extraction, at most
  3 per capture, optional, never blocking a suggestion. Answering is a capture
  (`answers_question_id`).
- **Reflective questions** (slice 2): optional and never nagging.

## 5. Known issues in ported code

All five issues the `legacy-v0` audit found were fixed in slice 1: the prompt carries capture
time + zone and dates resolve deterministically; a matched scale/number tracker without a value
no longer defaults to the minimum (falls back to an unlinked activity); mark-done is a
`{ status: 'done' }` patch; only an exact title match may auto-apply mark-done; record
timestamps default to capture time. Add new findings here.
