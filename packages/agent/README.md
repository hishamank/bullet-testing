# @bullet/agent

"The brain." The Ollama client (structured-output chat, embeddings, model pull/status), the
**extraction → resolution → suggestion** pipeline, the **serial inference queue** (single GPU
slot), reconciliation on edit, and a weekly-analysis stub.

Depends ONLY on `@bullet/core` + `@bullet/db` (+ `fuse.js`, `zod`, `zod-to-json-schema`). All
logic is **plain functions over an injected `deps` bundle** (`{ db, ollama, config, emitter }`),
so the whole pipeline is testable with an in-memory db (`createTestDb`) and a scripted Ollama
client. A future tRPC server (Task 4) is a thin wrapper around `createAgentRuntime`.

> **The Ollama client is ALWAYS mocked in tests** — CI never needs a live model. `HttpOllamaClient`
> is exercised against a stubbed global `fetch`; everything else uses `createScriptedOllamaClient`.
> See the root [`CLAUDE.md`](../../CLAUDE.md).

## Dependency injection

```ts
interface AgentDeps {
  db: Db // the @bullet/db handle — the ONLY way to touch the database
  ollama: OllamaClient // an interface — HttpOllamaClient in prod, a scripted fake in tests
  config: AgentConfig // models + tier thresholds
  emitter: AgentEmitter // typed event emitter (SSE source for the server)
}
```

Every pipeline function takes `deps` (or a subset) as its first argument. Nothing reaches for a
global, opens its own DB, or reads `process.env` deep in the pipeline.

## Public API (the barrel)

### Config — `src/config.ts`

- `loadAgentConfig(env = process.env): AgentConfig` — env → config with defaults.
- `AgentConfig` / `AGENT_CONFIG_DEFAULTS`.

| field              | env                        | default                  |
| ------------------ | -------------------------- | ------------------------ |
| `baseUrl`          | `OLLAMA_BASE_URL`          | `http://localhost:11434` |
| `liveModel`        | `OLLAMA_LIVE_MODEL`        | `gemma3:4b`              |
| `weeklyModel`      | `OLLAMA_WEEKLY_MODEL`      | `gemma3:4b`              |
| `autoThreshold`    | `AGENT_AUTO_THRESHOLD`     | `0.85`                   |
| `suggestThreshold` | `AGENT_SUGGEST_THRESHOLD`  | `0.5`                    |
| `autoCreateTasks`  | `AGENT_AUTO_CREATE_TASKS`  | `false`                  |

### Ollama client — `src/ollama/*`

- `interface OllamaClient` — `chat(req)` (with `format` for **structured output**: a JSON-schema
  object or `'json'`), `embed(req)` → `number[][]`, `pull(model)`, `listModels()`, `show(model)`.
  Strongly typed requests/responses.
- `HttpOllamaClient` — the real client over `fetch` (`/api/chat`, `/api/embed`, `/api/pull`,
  `/api/tags`, `/api/show`). Passes `format` through to enable structured output. No SDK.
- `createScriptedOllamaClient(script)` — the test/integration FAKE: canned chat/embed responses
  via a **handler** (`(req) => value`) or a **queue** (FIFO), and **records every call**
  (`client.calls` / `.chatCalls` / `.embedCalls`). Exported from the barrel so **Task 4 runs
  end-to-end without a live model**.

### Extraction — `src/extraction/*`

- `ExtractionSnapshot` = `{ trackers: {id,name,input_type}[]; openTasks: {id,title,status}[] }` —
  active tracker DEFINITIONS + OPEN (todo/in_progress) tasks. `buildSnapshot(deps, ownerId)`.
- `extractionResponseSchema` (zod) = `{ candidates: Candidate[] }`. A `Candidate` =
  `{ kind, orientation, text, fields, referenceName?, confidence }`. The Ollama `format`
  JSON-schema (`extractionJsonSchema`) is **derived from this zod schema** via
  `zod-to-json-schema` — one schema is the single source of truth for both the request `format`
  and response validation.
- `buildExtractionPrompt(bullet, snapshot)` — system prompt (the four kinds + the four
  orientations, reference-existing-by-name, split into multiple candidates) + user prompt with
  the bullet and inlined snapshot.
- `extractCandidates(deps, bullet, snapshot)` — `chat({ model: liveModel, format })`, parse JSON,
  validate; **retry ONCE** then throw a typed `AgentError` (`OLLAMA_PARSE` / `EXTRACTION_INVALID`).

### Resolution — `src/resolution/*` (the core decision)

`resolveCandidates(candidates, snapshot, config) → { suggestions: ResolvedSuggestion[]; skipped }`.
Each `ResolvedSuggestion` is a Suggestion INSERT draft `{ target_kind, operation, target_id,
payload, confidence, tier }`; `owner_id`/`source_bullet_id` are attached at persist time
(`withProvenance`). Matching uses **fuse.js** over the snapshot's tracker names / open-task titles.

#### §4.4 routing

| orientation        | condition                          | result                                                              |
| ------------------ | ---------------------------------- | ------------------------------------------------------------------ |
| `happened`         | strong tracker match               | `append` `tracker_entry`, `target_id = tracker.id`, `{value, logged_at}` |
| `happened`         | strong OPEN-task match              | `update` `task`, `target_id = task.id`, `{title, notes, due_at, priority, status:'done'}` (the matched task's live fields + `status:'done'`) |
| `happened`         | otherwise                          | `create` `activity` (linked iff confident, else **UNLINKED** — activity-first) |
| `future_oneoff`    | —                                  | `create` `task` `{title, due_at?, priority?}`                       |
| `future_recurring` | —                                  | `create` `tracker` DEFINITION `{name, input_type, config}`         |
| `durable_fact`     | —                                  | **SKIPPED** (Note is out of v1 scope) — counted (`skipped`), never emitted |

"Activity-first": a `happened` action with no confident match becomes an UNLINKED activity — we
never drop the data to indecision. A match is "confident" at fuse score ≥ `0.6` (normalised, 1 =
perfect). For append/update the final `confidence` is the **mean of the model confidence and the
fuse score**, so the number is explainable.

#### §4.5 tier policy — `assignTier(targetKind, operation, confidence, config)`

- **DEFINITION creates** (`target_kind ∈ DEFINITION_TARGET_KINDS`, i.e. `tracker`): **NEVER
  `auto`**, regardless of confidence → `confidence ≥ suggestThreshold ? 'suggest' : 'ask'`. This
  matches `@bullet/core`'s runtime invariant (a definition + `auto` fails the suggestion schema),
  so we must never produce it.
- **RECORDS** (`tracker_entry` append, `activity` create) and **instance UPDATES** (task
  mark-done): `confidence ≥ autoThreshold ? 'auto' : confidence ≥ suggestThreshold ? 'suggest' : 'ask'`.
- **TASK CREATE**: conservative — capped at `suggest` (we do not silently mint task lists). The
  cap is liftable via `config.autoCreateTasks` (default `false`).

> "Eagerness scales inversely with permanence": records auto, tasks need a nod, definitions
> always need a nod.

> **Payload provenance:** the apply/commit engine re-validates a suggestion's `payload` against
> the target kind's INSERT schema, which requires `owner_id` + `source_bullet_id` (and, for
> `tracker_entry`, `tracker_id`) **present on the payload**. `withProvenance` injects these into
> both the suggestion envelope AND the payload; the apply engine then forces provenance from the
> envelope, so the two can never disagree.
>
> **Task UPDATE (mark-done) is a FULL payload, not a partial.** That same INSERT-schema re-check
> applies to `update` too, and `taskInsertSchema` requires `title` plus the keys
> `notes`/`due_at`/`priority` present. A bare `{status:'done'}` would fail `INVALID_PAYLOAD` and be
> permanently unappliable. So `markTaskDone` builds the payload from the matched task's CURRENT
> fields (carried on the enriched `SnapshotTask`) plus `status:'done'`. Re-supplying the live
> values is safe: `applyUpdate` patches only keys the raw payload proposes, so they are a no-op on
> those fields while `status` is the lone intended mutation.

### Serial inference queue — `src/queue/*` (single GPU slot)

- `processExtractJob(deps, job)` — load bullet → `buildSnapshot` → `extractCandidates` →
  `resolveCandidates` → persist each as a Suggestion (PROVENANCE from the bullet) → **auto-apply**
  the `auto`-tier ones via `acceptSuggestion` (which re-validates against current state). Emits
  `extraction:complete`. Returns `{ suggestionIds, appliedIds, skipped }`.
- `createExtractionWorker(deps)` — the **sole consumer** of `extract_bullet` jobs (concurrency is
  strictly **1**). `start(intervalMs)` / `stop()` (polling loop, re-entrancy-guarded) and
  `drain()` (process all queued jobs, for tests). Claims one job at a time via the @bullet/db jobs
  repo (`claimNextJob → markJobDone`/`markJobFailed`). On a processing error it
  `markJobFailed(error)` and emits `extraction:error` — **the loop never crashes**.
- `enqueueExtraction(deps, bulletId, ownerId)` — enqueue an `extract_bullet` job (used by Task 4's
  `bullets.create`).

Events (subscribe via `deps.emitter`, type-exported as `AgentEmitter` / `AgentEvents`):

- `extraction:complete` `{ jobId, bulletId, suggestionIds, appliedIds }`
- `extraction:error` `{ jobId, bulletId, error }`

### Reconciliation — `src/reconcile/*` (§4.7)

`reprocessBullet(deps, bulletId)` — editing a bullet drops its previous analysis and re-runs
extraction, **reconciling** against already-applied extractions (keep matches, add new, retire
removed) rather than blindly recreating:

1. **Retire stale pending**: reject every still-pending suggestion for the bullet.
2. **Re-extract** the edited bullet.
3. **Reconcile creates**: for each new `create` draft, look for a matching APPLIED entity from
   this bullet (active row, same `target_kind`, normalized key field — title/name). If found →
   **KEEP** (skip, do not duplicate); else **persist** the draft (auto-apply if `auto`). `append`/
   `update` drafts are always persisted (they target a live definition/instance, not a
   from-this-bullet entity).
4. **Retire removed**: any applied entity from this bullet that matched no new `create` is
   soft-deleted.

**Limitations (v1):** matching is `target_kind` + a normalized key (`task.title` / `tracker.name`
/ `activity.name`); it does NOT diff field values, so a kept entity is not updated to match a
changed payload. `tracker_entries` are excluded from the create-dedupe set (they are append
records). Reconciliation is best-effort, not transactional across the whole reprocess.

### Weekly analysis stub — `src/weekly/*`

`createWeeklyAnalyzer(deps, { threshold = 3 })` — `analyze(ownerId)` scans active **UNLINKED**
activities (`tracker_id === null`), groups by normalized name, and for any group with count ≥
threshold proposes a Tracker DEFINITION suggestion (`create` `tracker`, tier **`suggest`** —
never auto). Returns the proposals (`persist(proposals)` stores them as pending Suggestions). Full
pattern detection is later.

### Runtime factory — `createAgentRuntime({ db, ollama, config })`

Wires the typed emitter, the serial worker, and bound helpers (`enqueueExtraction`,
`processExtractJob`, `reprocessBullet`, `weekly`) for the Task 4 server:

```ts
const agent = createAgentRuntime({ db, ollama, config })
agent.worker.start() // begin draining the queue (single GPU slot)
agent.enqueueExtraction(bulletId, ownerId) // on bullets.create
agent.emitter.on('extraction:complete', (e) => sse.send(e)) // SSE source
```

## Errors

`AgentError(code, message, details?)` with codes `OLLAMA_HTTP` | `OLLAMA_PARSE` |
`EXTRACTION_INVALID` | `NOT_FOUND`.

## Develop / verify

`@bullet/agent` imports the BUILT `dist` of `@bullet/core` + `@bullet/db`, so build first:

```sh
pnpm build                              # turbo: core → db → agent
pnpm --filter @bullet/agent typecheck
pnpm --filter @bullet/agent lint
pnpm --filter @bullet/agent test
```
