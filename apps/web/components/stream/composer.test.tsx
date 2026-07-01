// @vitest-environment jsdom

/**
 * Component test for the capture Composer — proves the keyboard contract that drives the whole app:
 * pressing Enter (without Shift) logs the bullet via `bullets.create` with the typed text, then
 * hands the new id up through `onCreated`.
 *
 * `useTRPC` is mocked so the test stays focused on the component's behavior (not the network): the
 * mocked `bullets.create.mutationOptions` returns a recording `mutationFn`, while a real
 * QueryClientProvider satisfies the `useMutation`/`useQueryClient` hooks the component uses.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { Composer } from './composer'

// Hoisted so the (hoisted) vi.mock factory can close over the same spy the test asserts on.
const { createMutationFn } = vi.hoisted(() => ({ createMutationFn: vi.fn() }))

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    bullets: {
      create: {
        mutationOptions: (opts: { onSuccess?: (bullet: { id: string }) => void }) => ({
          mutationKey: ['bullets', 'create'],
          mutationFn: createMutationFn,
          ...opts,
        }),
      },
    },
  }),
}))

afterEach(() => {
  cleanup()
  createMutationFn.mockReset()
})

function renderWithClient(node: ReactNode) {
  const queryClient = new QueryClient()
  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>)
}

test('pressing Enter logs the typed bullet via bullets.create and reports the new id', async () => {
  createMutationFn.mockResolvedValue({ id: 'bullet-123' })
  const onCreated = vi.fn()

  renderWithClient(<Composer onCreated={onCreated} />)

  const textarea = screen.getByLabelText('Write a bullet')
  fireEvent.change(textarea, { target: { value: 'remember to call the dentist' } })
  fireEvent.keyDown(textarea, { key: 'Enter' })

  // The mutation fires with exactly the typed text. We assert on the first (variables) argument.
  await waitFor(() => expect(createMutationFn).toHaveBeenCalled())
  expect(createMutationFn.mock.calls[0]?.[0]).toEqual({ text: 'remember to call the dentist' })
  // …and on success the new bullet id is handed up to the parent.
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith('bullet-123'))
})

test('Shift+Enter is a newline, not a submit', async () => {
  const onCreated = vi.fn()
  renderWithClient(<Composer onCreated={onCreated} />)

  const textarea = screen.getByLabelText('Write a bullet')
  fireEvent.change(textarea, { target: { value: 'first line' } })
  fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })

  // No mutation: Shift+Enter must not log the bullet.
  expect(createMutationFn).not.toHaveBeenCalled()
  expect(onCreated).not.toHaveBeenCalled()
})

test('Enter on an empty / whitespace-only draft does not log a bullet', async () => {
  const onCreated = vi.fn()
  renderWithClient(<Composer onCreated={onCreated} />)

  const textarea = screen.getByLabelText('Write a bullet')
  // Whitespace-only draft → submit()'s `draft.trim()` guard must short-circuit.
  fireEvent.change(textarea, { target: { value: '   ' } })
  fireEvent.keyDown(textarea, { key: 'Enter' })

  expect(createMutationFn).not.toHaveBeenCalled()
  expect(onCreated).not.toHaveBeenCalled()
})
