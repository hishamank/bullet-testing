import { defineConfig } from 'drizzle-kit'

/**
 * Drizzle Kit config — used to GENERATE the migration SQL from `src/schema.ts` into
 * `./drizzle`. The runtime client (`src/client.ts`) does not use this file; it resolves the
 * migrations folder itself.
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_PATH ?? './bullet.db',
  },
})
