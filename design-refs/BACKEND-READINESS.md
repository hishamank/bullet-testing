# Backend-readiness audit — Tasks / Trackers / Activities pages

Read-only audit done while designs are pending. Maps what's already wired vs. what each
page will need. No code was changed. Verified against `main` @ 7eeedd1.

## Design status (blocker)
- The three page **layouts are NOT in the design project.** "The Payoff" (`design-refs/the-payoff.dc.html`)
  designs **Overview + Timeline** only; Tasks/Trackers/Activities render as a "coming soon" stub
  (`soonInfo()`), with one-line intents only. The "Design System" project is empty.
- Per task instructions ("if a page's design is missing, ask the human — don't invent a look"),
  page implementation is **paused pending real designs** from the human.

## Procedures — all exist, all thin wrappers (`packages/server/src/routers/`)
| Router | Procedures | Notes |
|---|---|---|
| `tasks` | list, create, update, delete | Full CRUD. `update` covers status changes + due/priority/notes/title. `delete` = soft-delete. |
| `trackers` | list, create, update, delete | `create`/`update` validate `input_type`↔`config` coherence. |
| `trackerEntries` | list, create, update, delete | `create` = **manual entry logging**. |
| `activities` | list, create, update, delete | `update` accepts `tracker_id` → **linking backfill already possible**. |
| `suggestions` | listPending, accept, reject, edit | The confirm flow for activity→tracker candidates. |
| `weekly` | run | Analyzes unlinked activities → persists deduped proposals as **pending Suggestions**. |

## Entity fields (`packages/db/src/schema.ts`)
- **Task**: status(`todo|in_progress|done|migrated|cancelled`), title, notes, due_at, priority(`P1..P4`), source_bullet_id, +universal.
- **Tracker**: name, input_type(`scale|number|single_select|multi_select|boolean|text`), config(json, discriminated on input_type), +universal.
- **TrackerEntry**: tracker_id, value(json), logged_at, source_bullet_id, +universal.
- **Activity**: name, occurred_at, tracker_id(nullable link), notes, quantity(real), unit, source_bullet_id, +universal.
- Universal: id, owner_id, created_at, updated_at, state(`active|deleted`).

## Web reusables (`apps/web/`)
- `lib/use-journal-data.ts` — fetches all six lists; builds `bulletsById`, `trackersById`,
  `entitiesByBulletId` (provenance thread), `pendingByBulletId`. One batched round-trip.
- `lib/design.ts` — `GLYPH`, `KIND_LABEL`, `tagForRow`, **`statusPill(status)` already renders
  todo/in_progress/done/migrated/cancelled**, `taskGlyph` (done ✓ / migrated › / task •).
- `lib/view-model.ts` — `normalizeTask/Activity/TrackerEntry`, `suggestionRow`, `suggestionSummary`,
  `formatValue`, `indexBy`, `groupBy`.
- `lib/format.ts` — `dueLabel`, `dayKey`, `shortDay`, `formatTime`, `daysAgo`, etc.
- `components/overview/tracker-card.tsx` — **per-input_type viz** (numeric sparkline / boolean
  streak dots / select+text latest). Extend for the Trackers page.
- `components/overview/provenance.tsx` — the "↳ from your journal" expandable thread. Reuse as-is.
- `components/review/suggestion-row.tsx` — stage/accept/reject + inline Due/Status **chip** editor.
- `db.listEntriesByTracker(db, trackerId)` — already exists (per-tracker history read).

## Gaps to close per page (once designs land)

### Tasks
- CRUD, status groups, migrated-as-first-class (`statusPill`/`taskGlyph`) — **ready**.
- ⚠️ **The "reuse Review's edit-in-place form" premise is only half-true.** Review's editor is
  NOT a factored-out form component — it's inline Due/Status **chips** inside `suggestion-row.tsx`,
  with **no title or priority field**. A manual task create needs title + due + priority + status.
  → Plan: **extract a shared `TaskForm`** (title/due/priority/status) and use it in both the Tasks
  page (empty) and Review edit-in-place (pre-filled), OR build a Tasks form and refactor Review to it.
  This is a real refactor, not a drop-in reuse. Confirm scope with the design.
- No natural-language dates (chips pattern only) — out of scope, correct.

### Trackers
- Tracker CRUD, entry logging, per-entry provenance — **ready**.
- ❌ **New aggregation queries required in `packages/db` (+ tests + thin tRPC wrappers):**
  1. per-tracker **daily-bucketed series** (currently TrackerCard does ad-hoc last-14 math inline; a real day-bucketed query doesn't exist).
  2. **year-in-pixels** rollup (scale trackers).
  3. **streaks** (boolean trackers — current + longest).
- CRUD form must handle the `config` discriminated union: scale(min/max), number(unit), select(options).
- **Correlations** ("feel better on days you run") — optional; nothing exists; leave a marked seam unless the design commits to it.

### Activities
- list + CRUD + **linking via `activities.update({tracker_id})`** — **ready**.
- Unlinked→tracker candidates: `weekly.run` already surfaces these as pending Suggestions
  (routes through the normal Suggestion flow — satisfies "never a silent create"). For an on-page
  nudge, either reuse weekly proposals or add a read-only grouped-unlinked query. Design decision.
- Filtering (name / link-status) is pure client-side over `activities.list`.

## Repo hygiene bug (parallel workstream — flag, don't fix here)
- `packages/server/bullet.db-shm` and `bullet.db-wal` (SQLite runtime artifacts) were **committed**
  in PR #12 (commit `5918e64`) and are now tracked on `main`. `.gitignore` covers `*.db` but not
  `*.db-shm` / `*.db-wal`. Fix belongs to the agent/server workstream:
  `git rm --cached packages/server/bullet.db-shm packages/server/bullet.db-wal` + add
  `*.db-shm` / `*.db-wal` (or `*.db-*`) to `.gitignore`.
