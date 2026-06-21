# Bullet Journal

A **local-first bullet-journal app**. The user brain-dumps thoughts one bullet at a
time into a message-style input. After each bullet, a **local LLM agent** (via Ollama)
classifies it and extracts structured productivity entities — tasks, trackers,
activities — proposed as **suggestions** the user confirms. It runs entirely on the
user's machine. Privacy-first.

This repository contains the **engine, not the cockpit**: the domain core, database,
agent ("the brain"), and the tRPC backend. The feature UI is built separately.

## Monorepo layout

```
apps/
  web/        # Next.js (App Router) — scaffold only
packages/
  core/       # domain types, Zod schemas, apply/commit engine, create-vs-append logic
  db/         # Drizzle schema + migrations + repositories
  agent/      # Ollama client, extraction → resolution → suggestion pipeline, serial queue
```

Dependency direction: `db → core`, `agent → core + db`, tRPC server → `core + db + agent`,
`web → tRPC client only`.

## Getting started

```bash
nvm use            # Node 24 (LTS)
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

See [`CLAUDE.md`](./CLAUDE.md) for the full project context, conventions, and the
domain model that every contributor (human or agent) must follow.
