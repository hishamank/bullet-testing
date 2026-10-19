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
  client/     # @bullet/client — a client's local mirror (schema, migrations, local writes,
              #   outbox, pull merge, queries), the sync client, pure feature models and copy.
```

Dependency direction: `engine → core`; `server → core + engine`; `mobile` / `web` → `client`
→ `core` + `engine`, plus the server's API contract. **`core` and `engine` must stay pure:**
no DB drivers, no `node:*` imports, no React Native APIs — they run on the server, the phone and
the web. **`client` must stay runtime-free:** no React, React Native, Expo or browser-only APIs
and no DB driver. The app injects the database (any synchronous Drizzle SQLite handle over its
`schema`, typed `PhoneDb`), `fetch` (`createHttpTransport`), the recording reader
(`createSyncClient({ readAudioChunk })`) and clock/ids/time zone (`LocalDeps`). Apps keep only
their edges: the driver opener, device/runtime glue, hooks, components and routes.

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
- **Reflective questions** (slice 2, `apps/server/src/reflect`, contract §2e): a `reflect_jobs`
  row per capture, queued in the transaction that stores its extraction and claimed only when no
  extraction job is ready (never delays things); a few retries, then dropped quietly. The model
  sees only worry/question/idea thoughts (`reflectOnThoughts`; bad output = no question). A
  daily pass (`runReflectionPass`, scheduled in `main.ts`) reopens snoozed questions and adds
  "Still on your mind?" for 7-day-old open loops or an evergreen question. Every source goes
  through `reflectiveRefusal` (3 open, 2 a day, 14 days quiet; evergreen alone, every 3 days,
  paused 7 days after a `sensitive` thought). One reflective question per capture, ever.
- **Connections** (slice 3, `apps/server/src/connections`, engine `connections/`, contract §2f):
  embeddings through the `Embedder` interface (`/v1/embeddings` of a second llama-server started
  with `--embeddings`; scripted in tests), one vector per thought stored with the embedder key
  (model + template; another key re-embeds). A `link_jobs` row per capture runs after extraction
  and before the reflect job: `planLinks` (10 nearest, profile thresholds, ≤ 5 links per thought,
  vetoes respected), a live yes/no "answers?" check for close open loops → one `thought_resolve`
  suggestion (tier suggest, never auto, never counts toward `needs_review`, ignored by reconcile),
  and maybe a `connection` question that waits for the reflect job (one question per capture). The
  nightly run (`connections/nightly.ts`, 02:00 server `TZ`, in the worker when idle, one catch-up
  run after downtime) reviews links, clusters themes on uncapped similarity + links, names them
  (validated to be the user's words, Noticed denylist) and writes ≤ 2 Noticed cards a day. A chat
  model as embedder needs the `llm` profile (template + centring; calibrated thresholds in
  `docs/home-server.md`). Corrections (`link_vetoes`, `themes.vetoed_thought_ids`, aliases) are
  keyed by thought id, which survives edits while the text matches. Sensitive thoughts never
  appear outside their capture: a link carries `visible_from` (shown only from the capture whose
  other end isn't sensitive; never named after the flag), memberships, mostly-sensitive themes and
  quote-less cards are pulled as `deleted`, and a card's headline is rebuilt when its
  `headline_thought_id` turns sensitive. The nightly run yields (`shouldYield`) whenever a capture
  job is ready; it must never hold a capture back. A waiting `thought_resolve` counts in the badge.
- **Apply engine** (`apps/server/src/apply`): revalidates against current state at apply time;
  a created entity's id **is** the suggestion id (idempotent); `update` payloads are field-level
  patches validated by `targetKindUpdateSchemas` (never a snapshot); undo restores `before`
  values and refuses (`conflict`) if the user changed the result since.
- **Dates:** the model **quotes** date phrases (`fields.when`); `@bullet/engine` `time/`
  resolves them against the bullet's `captured_at` + IANA `timezone`. The engine never reads the
  clock; records default to capture time.
- **Voice notes keep their audio** (user decision, 2026-10-18). The recording is the source of
  truth, kept permanently on the phone and the server (soft delete only). The phone saves the
  live on-device draft (Apple SFSpeechRecognizer, on-device only) as the bullet text plus a
  `device_draft` transcript. The server re-transcribes in the `transcribing` state, before extraction, through
  the injected `Transcriber` interface (`@bullet/engine`; whisper.cpp later, scripted in tests).
  It stores a `server` transcript, which replaces the bullet text unless `text_edited_by_user`.
  Transcription is multilingual (English, Lebanese Arabic and French mixed): never force a
  language. A voice bullet's job waits (`waiting_audio`) until its recording has fully uploaded.
  Audio upload is `PUT /sync/audio/:id` with an `upload-offset` header: resumable, idempotent by
  attachment id, sha256-verified. Recordings live under `AUDIO_DIR` on the server. Until a
  transcriber is wired, voice bullets are processed on their device draft.
- **Voice capture on the phone** (logic `packages/client/src/features/voice`, device drivers and
  recorder hook `apps/mobile/src/features/voice`, `docs/voice-capture.md`):
  expo-speech-recognition writes 16 kHz WAV segments (one per stretch; Pause ends one) while the
  same mic tap feeds the on-device recognizer; Send joins them (`wav.ts`). expo-audio (m4a, no
  draft) when speech recognition is denied or can't start. Recording pauses (never stops) on a
  call, Siri or backgrounding; a killed recording is saved on the next one (`recoverRecordings`).
  Session logic is pure (`session.ts`, driver injected); needs a dev build, not Expo Go.
- **Phone data layer** (`packages/client/src/data`, `src/sync`, exported by `@bullet/client`):
  Drizzle over an injected sync SQLite driver (expo-sqlite on the phone, better-sqlite3 in Vitest,
  a browser SQLite later). Every local action writes its change **and** its outbox op in one
  transaction. Migrations are drizzle-kit SQL (`packages/client/drizzle`) inlined into
  `migrations.gen.ts` (`pnpm --filter @bullet/client db:generate`) and applied by the
  driver-agnostic `migrate(db)`, so the same code runs on device and in Vitest. On the phone,
  React Native / Expo APIs live only in the app's edges: `apps/mobile/src/data/open.ts`,
  `src/sync/settings.ts`, `src/sync/runtime.ts` (which also reads recording chunks with
  expo-file-system), the `features/*/actions.ts` handlers, `features/sync/engine.ts`, hooks and
  components; everything else is testable logic in `@bullet/client`. A refused
  suggestion/question op forces the next pull to be a full one (an unchanged server row would
  otherwise never come back); refused accepts, undos and answers are also logged in `sync_state`
  (`data/rejections.ts`) for calm UI notices. `outbox.hold_until` holds an op back (the Inbox's
  Undo window, `data/decisions.ts`); `pushAll` skips held ops and later ops on the same suggestion. The mobile test script is `pnpm exec vp test` because the app's TypeScript
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
- **Question** — `kind: clarifying` (slice 1): topic date | new_tracker | other, options;
  `kind: reflective` (slice 2): origin capture | open_loop | evergreen (`template_id`), no
  options, answered only by captures, `snoozed` once ("Later"). Status open | answered |
  dismissed | snoozed. Thoughts carry `sensitive` (never shown) and `never_ask`.

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
- **Reflective questions** (slice 2): optional and never nagging. About what the user said,
  never what they should do; never in the Inbox badge, never notified; nothing for a capture
  that reads as distress.

## 5. Known issues in ported code

All five issues the `legacy-v0` audit found were fixed in slice 1: the prompt carries capture
time + zone and dates resolve deterministically; a matched scale/number tracker without a value
no longer defaults to the minimum (falls back to an unlinked activity); mark-done is a
`{ status: 'done' }` patch; only an exact title match may auto-apply mark-done; record
timestamps default to capture time. Add new findings here.

- **Real-model run (2026-10-18, Qwen3.5-4B Q4_K_M; Gemma 4 26B compared; see
  `docs/home-server.md`):** segmentation translated mixed Arabizi/French/English thoughts to English
  (and mistranslated them). Fixed: `quote` is decoded before `text`, the prompt forbids translating,
  and a `text` that drifted from the verbatim words (`driftedFrom`) falls back to them. Dates now
  read French, Arabizi and Arabic day words and "15h"; a deadline ("before 10am") is a task, not an
  event; a date-only record is dated at capture time (today) or noon (earlier days), never midnight.
  Re-check with the user's own captures before further prompt tuning.
