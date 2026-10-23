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

/** Brute-force protection: too many auth attempts from one IP must be rejected. */
describe('auth rate limiting', () => {
  // 5 attempts per window, so the 6th must fail.
  const config = testConfig({ AUTH_RATE_LIMIT_MAX: '5', AUTH_RATE_LIMIT_WINDOW_MS: '60000' });
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

  it('returns 429 RATE_LIMITED in the standard error envelope after the limit', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'ratelimit.target@test.local', password: 'wrong on purpose' },
      });
      statuses.push(response.statusCode);
      if (response.statusCode === 429) {
        const body = response.json<{
          error: { code: string; message: string; requestId: string };
        }>();
        expect(body.error.code).toBe('RATE_LIMITED');
        expect(body.error.message).toMatch(/^Too many requests\./);
        expect(body.error.requestId).toBeTruthy();
      }
    }

    expect(statuses.filter((status) => status === 401)).toHaveLength(5);
    expect(statuses.filter((status) => status === 429)).toHaveLength(2);
  });
});
