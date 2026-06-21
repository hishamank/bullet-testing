'use client'

/**
 * tRPC client + TanStack Query wiring for the web scaffold.
 *
 * `web` depends on `@bullet/server` for the `AppRouter` TYPE ONLY — the import below is erased at
 * build time and never pulls in server runtime code (dependency direction: web → tRPC client only).
 */

import type { AppRouter } from '@bullet/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { createTRPCContext } from '@trpc/tanstack-react-query'
import { useState } from 'react'

export const { TRPCProvider, useTRPC } = createTRPCContext<AppRouter>()

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Scaffold default: don't hammer the local server on focus.
        staleTime: 30 * 1000,
      },
    },
  })
}

function makeTRPCClient() {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${API_URL}/trpc`,
      }),
    ],
  })
}

/** Client provider mounting QueryClientProvider + TRPCProvider around the app. */
export function Providers({ children }: { children: React.ReactNode }) {
  // Keep both clients stable across re-renders for the lifetime of the component.
  const [queryClient] = useState(makeQueryClient)
  const [trpcClient] = useState(makeTRPCClient)

  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    </QueryClientProvider>
  )
}
