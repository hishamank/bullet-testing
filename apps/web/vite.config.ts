import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'

// The bullet server the dev server forwards the sync API to (`vp dev` only; in production the
// home server serves this app itself, so everything is one origin).
const server = process.env.BULLET_SERVER_URL ?? 'http://127.0.0.1:3001'

export default defineConfig({
  plugins: [react()],
  // Relative asset URLs: the app works wherever the home server mounts it.
  base: './',
  build: {
    target: 'es2022',
    // The sql.js WebAssembly file stays a separate file under assets/, served by the home server.
    assetsInlineLimit: 0,
  },
  server: {
    proxy: { '/sync': server, '/health': server },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
})
