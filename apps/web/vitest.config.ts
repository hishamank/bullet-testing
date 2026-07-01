/**
 * Vitest config for `apps/web`.
 *
 * The app uses the `@/*` path alias (see tsconfig.json) for its internal imports. Vitest does not
 * read tsconfig paths, so we mirror that single alias here as a `resolve.alias` pointing `@` at the
 * app root — derived from this file's own URL so no extra dependency is needed. Two of the three
 * suites (pure helpers + an in-process server loop) run under the default `node` environment; the
 * component suite (`composer.test.tsx`) opts into jsdom per-file via `// @vitest-environment jsdom`.
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  // Use the automatic JSX runtime so component tests don't need an explicit `React` import (the app
  // relies on Next/SWC for this; tsconfig's `jsx: preserve` is for Next, not Vitest's esbuild).
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@': resolve(root, '.'),
    },
  },
})
