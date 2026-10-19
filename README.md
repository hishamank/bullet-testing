# Bullet Journal

A **mobile-first, offline-first bullet journal**. Open the phone, type or speak a thought, tap
Send, move on. Captures save on the device immediately; when the phone is online it syncs with a
home server that runs a local LLM (llama.cpp) and sends back suggestions to review later.
Privacy-first: journal text and recordings stay on your own hardware.

**Capture → thoughts → things.** A capture (typed, or spoken and kept with its audio) is split into
thoughts, each classified, and tasks, events, tracker readings and activities are extracted from
the actionable ones as suggestions. Built so far:

- **Slice 1:** capture, voice and Whisper transcription, storage, thoughts, extraction, clarifying
  questions.
- **Slice 2:** reflective questions.
- **Slice 3:** connections between captures, recurring themes and the Noticed cards.
- **Web desk client** (`apps/web`): the Stream and Inbox on a big screen, keyboard capture, served by
  the home server.

The previous web-first implementation is preserved at the git tag `legacy-v0`.

## Monorepo layout (Vite+)

```
apps/
  mobile/     # Expo (React Native) + Expo Router: the primary client, iOS first
  web/        # Vite + React: the desk companion, served by the server
  server/     # Node + Hono: sync ingest, processing queue, LLM calls (home machine)
packages/
  core/       # domain types + Zod schemas (pure TS)
  engine/     # extraction → resolution pipeline, LLM client interface (pure TS)
  client/     # shared client logic: local mirror + migrations, sync client, feature models
docs/         # getting-started, home-server, voice-capture, contract, e2e-results
```

## Development

Node 24 and pnpm 10.

```bash
pnpm install
pnpm exec vp check       # format, lint, type-check
pnpm test                # vp run -r test
pnpm build               # vp run -r build
pnpm dev:mobile          # expo start (needs a dev build on the phone, not Expo Go)
pnpm dev:web             # vite dev server (forwards /sync to the home server)
pnpm dev:server          # tsx watch, binds 127.0.0.1:3001
```

Tests never need a live model: the LLM client is always scripted.

## Using it

[`docs/getting-started.md`](./docs/getting-started.md) is the one ordered guide: building the model
servers, starting the bullet server, Tailscale, device tokens, the iPhone build and the browser.
Reference:

- [`docs/home-server.md`](./docs/home-server.md): every flag, environment variable and calibration.
- [`docs/voice-capture.md`](./docs/voice-capture.md): the phone's recorder and the dev build.
- [`docs/contract.md`](./docs/contract.md): bullet states and the sync protocol.
- [`docs/e2e-results.md`](./docs/e2e-results.md): results of runs against the real models.

[`CLAUDE.md`](./CLAUDE.md) holds the product context, domain model and locked engineering
decisions.
