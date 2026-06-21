# @bullet/core

Domain **types + Zod schemas** for the bullet-journal v1 base entity set, the shared field
conventions, and small **pure** helpers.

**Pure package:** Zod schemas, the TypeScript types inferred from them, and pure functions
only. No DB, no IO, no network, no `node:*`, no other workspace packages. The only dependency
is [`zod`](https://zod.dev). See the root [`CLAUDE.md`](../../CLAUDE.md) for the full
conventions and domain model.

## Single source of truth

Every TypeScript type is **inferred from its schema** (`export type X = z.infer<typeof
xSelectSchema>`) — shapes are never hand-duplicated. Import a schema for validation and the
matching type for annotations; they cannot drift.

## SELECT vs INSERT

Every entity exposes two schemas:

- **`<entity>SelectSchema`** — the full persisted row (every column required).
- **`<entity>InsertSchema`** — creation input. The server-managed fields
  `id` / `created_at` / `updated_at` / `state` are **optional** (the server mints them), and
  defaultable fields carry a `.default()`:
  - `task.status` → defaults to `'todo'`
  - `suggestion.status` → defaults to `'pending'`

`owner_id` and `source_bullet_id` remain required on insert (the caller knows the owner and
provenance). `User` has no `owner_id`/`source_bullet_id`; `Bullet` has no `source_bullet_id`
(the bullet *is* the provenance anchor).

## Field conventions (encoded once)

Locked decisions from `CLAUDE.md`, encoded as reusable building blocks in `src/primitives.ts`
and `src/base.ts` so entities **compose** them instead of copy-pasting:

- **Timestamps** = epoch **milliseconds**, `z.number().int().nonnegative()` — never strings.
  Applies to `created_at`, `updated_at`, `due_at`, `occurred_at`, `logged_at`, `resolved_at`.
- **IDs / `owner_id` / foreign keys** = UUID strings, `z.string().uuid()`.
- **`state`** = `'active' | 'deleted'` (soft delete only).
- **`source_bullet_id`** = provenance; nullable UUID on extracted entities, **non-null** on a
  `Suggestion` (a suggestion always derives from a bullet).
- `ownedTimestampedStateFields` / `ownedTimestampedStateInsertFields` bundle
  `{ id, owner_id, created_at, updated_at, state }` for SELECT / INSERT respectively.

## Entities

`User`, `Bullet`, `Task`, `Tracker`, `TrackerEntry`, `Activity`, and the extraction envelope
`Suggestion`. Each exports `…SelectSchema`, `…InsertSchema`, and inferred `T` / `TInsert`
types.

## Enums / closed unions

Exported as Zod enums **and** inferred union types: `RecordState`, `TaskStatus`,
`TaskPriority`, `TrackerInputType`, `SuggestionStatus`, `SuggestionTier`,
`SuggestionOperation`, `TargetKind`. `TargetKind` is `task | tracker | tracker_entry |
activity` in v1 and designed to extend later.

## Key design decision — Tracker config modeling

A `Tracker` carries a top-level `input_type` and a `config` whose shape **must match** it.
`config` is a **discriminated union on `input_type`**, with refinements that actually fire:

| `input_type`                  | config shape                            | enforced rule                       |
| ----------------------------- | --------------------------------------- | ----------------------------------- |
| `scale`                       | `{ min, max, labels? }` (int min/max)   | `min < max`                         |
| `number`                      | `{ unit?, min?, max? }`                 | `min <= max` when both present      |
| `single_select` `multi_select`| `{ options: string[] }`                 | `>= 1` option, each non-empty       |
| `boolean` `text`              | `{}`                                    | —                                   |

Because Zod v3's `discriminatedUnion` cannot take a `.refine`d (`ZodEffects`) member, the
`min`/`max` checks are re-applied in a single `superRefine` over the union. A top-level
`superRefine` on the Tracker also asserts `tracker.input_type === config.input_type`, so the
two can never drift.

A `TrackerEntry.value` is the structural union `number | string | boolean | string[]`. Which
variant is valid for a given entry depends on the parent tracker's `input_type`; that
cross-entity check belongs to the apply/resolve layer (it needs the tracker), not here.

## Key design decision — payload validation

A `Suggestion.payload` is a loosely-typed record (`Record<string, unknown>`) on the envelope.
`src/registry.ts` maps each `TargetKind` to that kind's **INSERT schema**
(`targetKindInsertSchemas`) and exposes:

```ts
import { validateSuggestionPayload } from '@bullet/core'

const result = validateSuggestionPayload('task', payload)
//    ^ Zod SafeParseReturnType — inspect result.success / result.error / result.data
```

`validateSuggestionPayload(target_kind, payload)` is **pure** and never throws: it returns the
Zod `SafeParseReturnType` of parsing `payload` against the kind's insert schema (per
`CLAUDE.md` §4.3 — the payload is validated against that kind's Zod schema). `insertSchemaFor`
returns the schema directly when you already know the kind.

## Develop

```sh
pnpm --filter @bullet/core build       # tsup → dist (ESM + .d.ts)
pnpm --filter @bullet/core typecheck   # tsc --noEmit
pnpm --filter @bullet/core lint        # biome check
pnpm --filter @bullet/core test        # vitest run
```
