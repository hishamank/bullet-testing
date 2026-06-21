'use client'

/**
 * Scaffold-only placeholder page.
 *
 * It exists purely to prove the end-to-end wire: it round-trips a tRPC call (`system.echo`) to the
 * local server on the CLIENT (so `next build` never needs a running server) and renders a shadcn
 * Button to prove shadcn + Tailwind compile and render. NO feature UI lives here — the real UI is
 * built via the design tool.
 */

import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { useTRPC } from '@/lib/trpc'

export default function Home() {
  const trpc = useTRPC()
  const echo = useQuery(trpc.system.echo.queryOptions({ message: 'hello from the web scaffold' }))

  return (
    <main className="mx-auto flex min-h-svh max-w-xl flex-col justify-center gap-6 p-8">
      <div className="space-y-2">
        <h1 className="font-semibold text-2xl tracking-tight">Bullet Journal — web scaffold</h1>
        <p className="text-muted-foreground text-sm">
          Scaffold only. The real UI is built via the design tool; do not build feature components
          here. This page exists to prove the end-to-end tRPC wire.
        </p>
      </div>

      <div className="rounded-lg border p-4 text-sm">
        <p className="mb-1 font-medium">tRPC round-trip — system.echo</p>
        {echo.isPending ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : echo.isError ? (
          <p className="text-destructive">
            Error: {echo.error.message} (is the local server running on :3001?)
          </p>
        ) : (
          <p className="text-muted-foreground">
            Server echoed: <span className="text-foreground">{echo.data.message}</span>
          </p>
        )}
      </div>

      <div>
        <Button onClick={() => echo.refetch()}>Re-run echo</Button>
      </div>
    </main>
  )
}
