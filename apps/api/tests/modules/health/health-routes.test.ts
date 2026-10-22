import type { Redis } from 'ioredis';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../../src/app.js';
import { parseConfig, type AppConfig } from '../../../src/lib/env.js';
import type { SeatrushFastifyInstance } from '../../../src/lib/logger.js';
import { probePostgres } from '../../../src/lib/postgres.js';
import { createRedisClient, probeRedis } from '../../../src/lib/redis.js';

/**
 * These are integration tests: they talk to a REAL PostgreSQL and Redis, because
 * the thing under test is connectivity itself. Start them with:
 *   docker compose up -d
 *
 * CI provides the same services as service containers (see .github/workflows/ci.yml).
 */

const DEFAULT_DATABASE_URL = 'postgres://seatrush:seatrush_dev_password@localhost:5432/seatrush';
const DEFAULT_REDIS_URL = 'redis://localhost:6379';
// Port 1 is never served locally, so this URL fails fast and deterministically.
const UNREACHABLE_REDIS_URL = 'redis://127.0.0.1:1';

function testConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  return parseConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? DEFAULT_DATABASE_URL,
    REDIS_URL: process.env['TEST_REDIS_URL'] ?? DEFAULT_REDIS_URL,
    ...overrides,
  });
}

describe('GET /health against real infrastructure', () => {
  const config = testConfig();
  let app: SeatrushFastifyInstance;
  let postgres: Pool;
  let redis: Redis;

  beforeAll(async () => {
    // Fail loudly and actionably if the developer forgot to start Docker.
    const preflightPool = new Pool({
      connectionString: config.databaseUrl,
      connectionTimeoutMillis: 3000,
    });
    const postgresProbe = await probePostgres(preflightPool, 3000);
    await preflightPool.end();
    if (postgresProbe.status === 'down') {
      throw new Error(
        `Postgres is not reachable (${postgresProbe.error ?? 'unknown error'}). Run: docker compose up -d`,
      );
    }

    const preflightRedis = createRedisClient(config);
    const redisProbe = await probeRedis(preflightRedis, 3000);
    await preflightRedis.quit().catch(() => preflightRedis.disconnect());
    if (redisProbe.status === 'down') {
      throw new Error(
        `Redis is not reachable (${redisProbe.error ?? 'unknown error'}). Run: docker compose up -d`,
      );
    }

    postgres = new Pool({ connectionString: config.databaseUrl, connectionTimeoutMillis: 3000 });
    redis = createRedisClient(config);
    app = buildServer({ config, postgres, redis });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await redis?.quit().catch(() => redis?.disconnect());
    await postgres?.end();
  });

  it('reports 200 and status=ok when Postgres and Redis both answer', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-request-id']).toBeTruthy();

    const body = response.json<{
      status: string;
      service: string;
      uptimeSeconds: number;
      timestamp: string;
      checks: {
        postgres: { status: string; latencyMs: number };
        redis: { status: string; latencyMs: number };
      };
    }>();

    expect(body.status).toBe('ok');
    expect(body.service).toBe('seatrush-api');
    expect(body.checks.postgres.status).toBe('up');
    expect(body.checks.redis.status).toBe('up');
    expect(body.checks.postgres.latencyMs).toBeGreaterThanOrEqual(0);
    expect(body.checks.redis.latencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof body.uptimeSeconds).toBe('number');
    // Server-generated timestamp: it must parse as a recent ISO-8601 instant.
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });

  it('honours an inbound x-request-id so a trace survives across services', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'trace-abc-123' },
    });

    expect(response.headers['x-request-id']).toBe('trace-abc-123');
  });

  it('returns the documented 404 envelope for an unknown route', async () => {
    const response = await app.inject({ method: 'GET', url: '/does-not-exist' });

    expect(response.statusCode).toBe(404);
    const body = response.json<{ error: { code: string; message: string; requestId: string } }>();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toBeTruthy();
  });
});

describe('GET /health when a dependency is down', () => {
  it('returns 503 with status=degraded and reports which check failed', async () => {
    // Real Postgres, deliberately broken Redis: proves a single failure is isolated.
    const config = testConfig({ REDIS_URL: UNREACHABLE_REDIS_URL });
    const postgres = new Pool({
      connectionString: config.databaseUrl,
      connectionTimeoutMillis: 3000,
    });
    const redis = createRedisClient(config);
    const app = buildServer({ config, postgres, redis });

    try {
      const response = await app.inject({ method: 'GET', url: '/health' });

      expect(response.statusCode).toBe(503);
      const body = response.json<{
        status: string;
        checks: { postgres: { status: string }; redis: { status: string; error?: string } };
      }>();

      expect(body.status).toBe('degraded');
      expect(body.checks.postgres.status).toBe('up');
      expect(body.checks.redis.status).toBe('down');
      // The failure reason is present but must never leak the connection string.
      expect(body.checks.redis.error).toBeTruthy();
      expect(JSON.stringify(body)).not.toContain('@');
    } finally {
      await app.close();
      await redis.quit().catch(() => redis.disconnect());
      await postgres.end();
    }
  });

  it('returns 503 with both checks down when nothing is reachable', async () => {
    // Deliberately uses no infrastructure at all, so this case runs anywhere.
    const config = testConfig({
      REDIS_URL: UNREACHABLE_REDIS_URL,
      DATABASE_URL: 'postgres://seatrush:seatrush_dev_password@127.0.0.1:1/seatrush',
      HEALTH_CHECK_TIMEOUT_MS: '1000',
    });
    const postgres = new Pool({
      connectionString: config.databaseUrl,
      connectionTimeoutMillis: 1000,
    });
    const redis = createRedisClient(config);
    const app = buildServer({ config, postgres, redis });

    try {
      const response = await app.inject({ method: 'GET', url: '/health' });

      expect(response.statusCode).toBe(503);
      const body = response.json<{
        status: string;
        checks: {
          postgres: { status: string; error?: string };
          redis: { status: string; error?: string };
        };
      }>();

      expect(body.status).toBe('degraded');
      expect(body.checks.postgres.status).toBe('down');
      expect(body.checks.redis.status).toBe('down');
      // Password must not survive redaction inside the response payload.
      expect(JSON.stringify(body)).not.toContain('seatrush_dev_password');
    } finally {
      await app.close();
      await redis.quit().catch(() => redis.disconnect());
      await postgres.end();
    }
  });
});
