/**
 * Shared helpers for integration tests.
 *
 * Every integration test in this package talks to the REAL Postgres (isolated
 * seatrush_test schema) and the REAL Redis container, per AGENTS.md: mocks would
 * not exercise the constraints this phase is about.
 */

import { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { parseConfig, type AppConfig } from '../../src/lib/env.js';
import { createRedisClient, probeRedis } from '../../src/lib/redis.js';
import { probePostgres } from '../../src/lib/prisma.js';
import { resolveTestDatabaseUrl } from '../../prisma/test-database.js';

export function testConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  return parseConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    // Deterministic test secrets. Still 32+ chars so the production-strength
    // validator is genuinely exercised, but committed on purpose: a test secret is
    // not a secret, and the tests must be able to forge/expire tokens.
    JWT_ACCESS_SECRET: 'test-access-secret-not-a-real-value-000000000000',
    JWT_REFRESH_SECRET: 'test-refresh-secret-not-a-real-value-0000000000',
    DATABASE_URL: resolveTestDatabaseUrl(process.env),
    REDIS_URL:
      process.env['TEST_REDIS_URL'] ?? process.env['REDIS_URL'] ?? 'redis://localhost:6379',
    ...overrides,
  });
}

/**
 * Title prefix for shows created BY TESTS, as opposed to shows created by the
 * seed.
 *
 * Vitest runs test files in parallel against one shared `seatrush_test`
 * schema, so a suite that creates its own rows makes them visible to every
 * other suite. Tests that assert on the seeded data filter this prefix out
 * rather than assuming the schema contains nothing but seed rows.
 */
export const TEST_FIXTURE_SHOW_PREFIX = 'ZZ Test Fixture: ';

export function testPrisma(config: AppConfig = testConfig()): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
}

/**
 * Fails loudly and actionably when the developer forgot to start Docker or to
 * prepare the test database (`pnpm --filter api db:test:prepare`).
 */
export async function assertInfrastructureReady(config: AppConfig = testConfig()): Promise<void> {
  const prisma = testPrisma(config);
  const redis = createRedisClient(config);
  try {
    const postgresProbe = await probePostgres(prisma, 4000);
    if (postgresProbe.status === 'down') {
      throw new Error(
        `Postgres is not reachable (${postgresProbe.error ?? 'unknown error'}). ` +
          'Start it with: docker compose up -d --wait, then run: pnpm --filter api db:test:prepare',
      );
    }
    const redisProbe = await probeRedis(redis, 4000);
    if (redisProbe.status === 'down') {
      throw new Error(
        `Redis is not reachable (${redisProbe.error ?? 'unknown error'}). ` +
          'Start it with: docker compose up -d --wait (or set TEST_REDIS_URL).',
      );
    }
    // A reachable but unmigrated database would otherwise fail every query with a
    // confusing missing-table error.
    const showCount = await prisma.show.count();
    if (showCount === 0) {
      throw new Error(
        'The test database has no data. Run: pnpm --filter api db:test:prepare ' +
          '(migrates + seeds the seatrush_test schema).',
      );
    }
  } finally {
    await redis.quit().catch(() => redis.disconnect());
    await prisma.$disconnect();
  }
}

export async function closeQuietly(client: Redis | PrismaClient): Promise<void> {
  if ('quit' in client) {
    await (client as Redis).quit().catch(() => (client as Redis).disconnect());
  } else {
    await (client as PrismaClient).$disconnect();
  }
}
