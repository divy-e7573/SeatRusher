import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../../src/app.js';
import type { SeatrushFastifyInstance } from '../../../src/lib/logger.js';
import { createRedisClient } from '../../../src/lib/redis.js';
import {
  assertInfrastructureReady,
  closeQuietly,
  testConfig,
  testPrisma,
} from '../../helpers/test-app.js';

// Port 1 is never served locally, so these URLs fail fast and deterministically.
const UNREACHABLE_REDIS_URL = 'redis://127.0.0.1:1';
const UNREACHABLE_DATABASE_URL =
  'postgres://seatrush:seatrush_dev_password@127.0.0.1:1/seatrush?connect_timeout=1';

describe('GET /health against real infrastructure', () => {
  const config = testConfig();
  let app: SeatrushFastifyInstance;
  let prisma: PrismaClient;
  let redis: Redis;

  beforeAll(async () => {
    await assertInfrastructureReady(config);
    prisma = testPrisma(config);
    redis = createRedisClient(config);
    app = buildServer({ config, prisma, redis });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await closeQuietly(redis);
    await closeQuietly(prisma);
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
    const prisma = testPrisma(config);
    const redis = createRedisClient(config);
    const app = buildServer({ config, prisma, redis });

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
      expect(body.checks.redis.error).toBeTruthy();
      expect(JSON.stringify(body)).not.toContain('@');
    } finally {
      await app.close();
      await closeQuietly(redis);
      await closeQuietly(prisma);
    }
  });

  it('returns 503 with both checks down when nothing is reachable', async () => {
    const config = testConfig({
      REDIS_URL: UNREACHABLE_REDIS_URL,
      DATABASE_URL: UNREACHABLE_DATABASE_URL,
    });
    const prisma = testPrisma(config);
    const redis = createRedisClient(config);
    const app = buildServer({ config, prisma, redis });

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
      expect(JSON.stringify(body)).not.toContain('seatrush_dev_password');
    } finally {
      await app.close();
      await closeQuietly(redis);
      await closeQuietly(prisma);
    }
  });
});
