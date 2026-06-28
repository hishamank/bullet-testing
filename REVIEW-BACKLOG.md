# Review backlog

This file catalogs findings from the thermo-nuclear code-quality reviews that were
**intentionally deferred** or **rejected** rather than applied. Each entry has a matching
marker comment at the code site:

- `// TODO(review): … — see REVIEW-BACKLOG.md` — a deferred item (left as-is for now).
- `// NOTE(review): … — see REVIEW-BACKLOG.md` — a decision recorded against a proposal.
- `// NOTE: …` — an intentional design choice that looked like a finding but is correct.

If you are about to "fix" code that carries one of these markers, read the relevant entry
first — the trade-off was already considered.

## @bullet/core

### Deferred

- **`insertSchemaFor` thin wrapper** — `packages/core/src/registry.ts`.
  Finding: `insertSchemaFor(kind)` is a one-line wrapper over `targetKindInsertSchemas[kind]`;
  the map is already exported, so callers could index it directly.
  Why deferred: kept on purpose for call-site ergonomics — a named, documented accessor reads
  better than a raw index access and gives downstream packages a stable, discoverable API
  surface. Low stakes (one line). Revisit only if no call site ever prefers the function form.

- **`User` left hand-rolled** — `packages/core/src/entities/user.ts`.
  Finding: every other entity composes its lifecycle fields from `base.ts`
  (`ownedTimestampedStateFields`); `User` re-lists `id`/`created_at`/`updated_at` by hand.
  Why deferred: `User` is the owner-root — it has NO `owner_id` and NO `state`, so the full
  owned bundle does not fit. `base.ts` exposes no smaller `id + timestamps` primitive to reuse,
  and inventing a one-off primitive for a single unowned entity would add abstraction without
  reuse. Left hand-rolled with an inline `NOTE`. Revisit if a second unowned entity ever
  appears (then a shared `timestampedFields` primitive becomes worth it).

### Decided against

- **Generic `makeEntity(extraFields)` SELECT/INSERT factory** — marker in
  `packages/core/src/base.ts`.
  Proposal: a single factory that emits both the SELECT and INSERT schema for an entity from a
  set of extra fields, replacing the per-entity explicit `z.object({ ...base, ...fields })`.
  Decision: **rejected.** It would *spread* complexity rather than delete it — adding
  indirection and harder-to-read Zod inference — while fighting the per-entity overrides that
  make this domain layer correct: `User` has no owner/state, `Bullet` has no provenance,
  `Suggestion` has non-null provenance plus defaulted `status`, `Task`/`Suggestion` default
  their `status`. For a small, fixed (7-entity) domain layer that downstream packages read
  constantly, explicit-per-entity schemas are clearer than a factory. Do not re-propose.

## @bullet/db

### Deferred

- **`validatePayloadOrThrow` widens core's precise per-kind type** — `packages/db/src/apply.ts`
  (`validatePayloadOrThrow`, the `return res.data as Record<string, unknown>` cast).
  Finding: `validateSuggestionPayload(kind, payload)` (core) returns a per-kind-narrowed
  `safeParse` result, but the wrapper immediately casts `res.data` to `Record<string, unknown>`,
  erasing the typing core worked to provide. The reviewer noted the cast could disappear IF the
  create/update paths were per-kind so each branch held the narrowed insert type.
  Why deferred: the apply layer is genuinely polymorphic over `target_kind` (one `applySuggestion`
  / `applyUpdate` body handles all kinds), and the `update` path reads keys off the payload by
  string (`for (const key of ['status','title',…])`), so a union-narrowed type would have to be
  re-narrowed per branch — the cast is the deliberate boundary that keeps that stringly-keyed path
  honest in one place. The #3 `CREATE_BY_KIND` registry refactor was applied but it dispatches on
  the already-erased `Record<string, unknown>` (the create functions re-parse `input` through their
  own INSERT schema anyway), so it did NOT naturally thread a narrowed type back to this cast.
  Removing the cast cleanly would require per-kind apply branches — churn out of proportion to the
  one-line boundary. Left with an inline `TODO(review)` marker. Revisit if the apply paths ever go
  per-kind for another reason.

## @bullet/agent

### Deferred

- **`createAgentEmitter` double-cast (`as unknown as AgentEmitter`)** — `packages/agent/src/events.ts`.
  Finding: `new EventEmitter() as unknown as AgentEmitter` is the classic "I'm overriding the type
  system" smell — the one structural-typing escape hatch in the package. The reviewer called it
  acceptable/contained: the typed facade (`AgentEmitter` over `AgentEvents`) is the right call and
  the surface is sound.
  Why deferred: the alternative — a small wrapper object delegating `on`/`once`/`off`/`emit` to a
  private `EventEmitter` — would *add* more code than it removes for no behavioral gain, and the
  cast is confined to this one factory (callers only ever see the typed `AgentEmitter`). Left with
  an inline `TODO(review)` marker. Revisit only if the emitter grows methods or the cast leaks.

## @bullet/server

### Deferred

- **By-id access is not owner-scoped** — `packages/server/src/routers/bullets.ts` and
  `routers/tasks.ts` (and the sibling entity routers).
  Finding: the `get`/`update`/`delete` procedures resolve a row purely by `id` without verifying
  `row.owner_id === ctx.ownerId`. Correct and harmless while v1 is single-user (one owner), but a
  leak vector once multiple owners share a db.
  Why deferred: v1 is single-user by locked decision (CLAUDE.md §3); enforcing owner-scoping now
  would add a check exercised by no current path. Tracked at the code sites as
  `TODO(multi-user)` markers. Revisit before any multi-user / hosted future — at the same time the
  `owner_id` plumbing throughout the stack gets real auth behind it.

### Decided against

- **Generic `crudRouter` factory collapsing the four entity routers** — marker at the top of
  `packages/server/src/routers/index.ts`.
  Proposal: a single `crudRouter({ create, list, update, softDelete, input, label })` builder to
  replace the four near-identical `tasks` / `trackers` / `trackerEntries` / `activities` routers
  (~150 lines → ~40).
  Decision: **rejected** — a TRAP, not an opportunity. The variation isn't uniform
  (`trackerEntryUpdateInput` omits `tracker_id`; `trackers` rebuild their input from `ZodEffects`
  building blocks), so a factory would need per-entity escape hatches that re-introduce the
  branching it claims to delete. Over only four call sites it trades four trivially-greppable
  ~35-line files — each a thin, boring, direct wrapper, the rubric's stated ideal — for one
  higher-order function whose generic types (`Partial<TInsert>` patch, the `T | undefined → throw`
  shape) read worse and degrade jump-to-definition for the web client. Four small honest
  duplications beat one clever abstraction across four sites. Do not re-propose. Revisit only if a
  fifth/sixth entity lands.
