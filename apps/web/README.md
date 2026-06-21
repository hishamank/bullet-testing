# web — Bullet Journal (scaffold only)

> **UI is built via the design tool; this is scaffold only — do not build feature components here.**
> No bullet input, no journal stream, no suggestion cards, no entity views. This package is the
> *wire*, not the cockpit: a Next.js App Router app with a tRPC client wired to the local server,
> one shadcn primitive, and one placeholder page that round-trips a tRPC call.

## What's in here

- **Next.js 16 (App Router)** + **React 19** + **Tailwind v4**.
- **tRPC v11 client** via the `@trpc/tanstack-react-query` integration, typed end-to-end against
  the server's `AppRouter` **type** (`import type { AppRouter } from '@bullet/server'` — type only,
  erased at build; the web app never imports server runtime code).
- **shadcn/ui infrastructure** initialized (`components.json`, `lib/utils.ts` `cn()`, design-token
  CSS variables in `app/globals.css`) plus **exactly one** primitive — `components/ui/button.tsx` —
  used once on the placeholder page to prove shadcn + Tailwind render.
- **One placeholder page** (`app/page.tsx`) that round-trips `system.echo` on the **client**.

## The wire (how it proves end-to-end)

- `lib/trpc.tsx` — `createTRPCContext<AppRouter>()` → `{ TRPCProvider, useTRPC }`, builds a
  `QueryClient` + a tRPC client (`createTRPCClient` with an `httpBatchLink` to
  `${NEXT_PUBLIC_API_URL}/trpc`), and exports a `Providers` client component wrapping children in
  `QueryClientProvider` + `TRPCProvider`. Mounted in `app/layout.tsx`.
- `app/page.tsx` — a **client** component. It calls
  `useQuery(trpc.system.echo.queryOptions({ message: '…' }))` and renders loading / error / the
  echoed message, plus the shadcn `Button`. Because the fetch happens on the client, **`next build`
  succeeds without a running server**.

The page round-trips **`system.echo`** (a tRPC query) against the standalone `@bullet/server`.

## Environment

| Var | Default | Meaning |
| --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | `http://localhost:3001` | Base URL of the standalone server; the client appends `/trpc`. |

Copy `.env.example` to `.env.local` to override. The server's `CORS_ORIGIN` defaults to
`http://localhost:3000` (this app's dev port), so the browser round-trip works out of the box.

## Running

```bash
# from the repo root — runs the standalone server (:3001) and the web app (:3000) together
pnpm dev
```

`pnpm dev` fans out via Turbo: `@bullet/server` serves tRPC on **:3001** and `web` runs Next on
**:3000**. Open <http://localhost:3000> and you'll see the placeholder page echo a message back
through tRPC. (A live Ollama is *not* needed for `system.echo` / `system.health`.)

```bash
# build (Turbo builds @bullet/server's type first, then `next build` for web)
pnpm build

# typecheck — proves the tRPC client is typed against AppRouter end-to-end
pnpm --filter web typecheck

# lint/format (Biome)
pnpm --filter web lint
```

## Boundary

This package intentionally stays a scaffold. Business logic lives in `@bullet/core` /
`@bullet/db` / `@bullet/agent`; the server exposes it over tRPC; **web depends on the tRPC client
(and the `AppRouter` type) only**. The feature UI is produced by the design tool, not authored here.
