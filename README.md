# Bullet Journal

A **mobile-first, offline-first bullet journal**. Open the phone, type or speak a thought, tap
Send, move on. Captures save on the device immediately; when the phone is online it syncs with
a home server, which runs a local LLM (llama.cpp) to extract tasks, events, trackers and
activities and sends back suggestions to review later. Privacy-first: journal text stays on the
user's own hardware.

The previous web-first implementation is preserved at the git tag `legacy-v0`.

## Monorepo layout (Vite+)

```
apps/
  mobile/     # Expo (React Native) + Expo Router — the primary client, iOS first
  web/        # Vite + React — secondary client (review, dashboards)
  server/     # Node + Hono — sync ingest, processing queue, LLM calls (home machine)
packages/
  core/       # domain types + Zod schemas (pure TS)
  engine/     # extraction → resolution pipeline, LLM client interface (pure TS)
```

## Getting started

```bash
pnpm install
pnpm exec vp check       # format, lint, type-check
pnpm test                # vp run -r test
pnpm build               # vp run -r build
pnpm dev:mobile          # expo start
pnpm dev:web             # vite dev server
pnpm dev:server          # tsx watch, binds 127.0.0.1:3001
```

See [`CLAUDE.md`](./CLAUDE.md) for the product context, domain model and locked engineering
decisions.
