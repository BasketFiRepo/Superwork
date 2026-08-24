import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'packages/**/*.test.ts'],
    // The isolation and permission packs talk to a real database; they must not race.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    setupFiles: ['./tests/helpers/env.ts'],
  },
  resolve: {
    alias: {
      '@superwork/config': resolve('./packages/config/src/index.ts'),
      '@superwork/db': resolve('./packages/db/src/index.ts'),
      '@superwork/core': resolve('./packages/core/src/index.ts'),
      '@superwork/auth': resolve('./packages/auth/src/index.ts'),
      '@superwork/ai': resolve('./packages/ai/src/index.ts'),
      '@superwork/tools': resolve('./packages/tools/src/index.ts'),
      '@superwork/agent': resolve('./packages/agent/src/index.ts'),
      // Added for ADR 0084: the first test to reach for a provider directly, because the mock
      // is what makes `EmailProvider.sync()` exercisable without a credential.
      '@superwork/integrations': resolve('./packages/integrations/src/index.ts'),
    },
  },
})
