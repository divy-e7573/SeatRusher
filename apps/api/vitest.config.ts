import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Integration tests open real TCP connections to Postgres/Redis and run queries,
    // so the default 5s timeout is too tight on a cold Docker Desktop.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
