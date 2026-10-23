import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../../src/app.js';
import type { SeatrushFastifyInstance } from '../../../src/lib/logger.js';
import { createRedisClient } from '../../../src/lib/redis.js';
import { seatHoldKey } from '../../../src/lib/redis-keys.js';
import { ERROR_CODE_HOLD } from 'shared';
import {
  assertInfrastructureReady,
  closeQuietly,
  testConfig,
  testPrisma,
} from '../../helpers/test-app.js';
import {
  authHeader,
  clearAllHolds,
  createIsolatedShow,
  registerUser,
  seatAt,
  type TestUser,
} from '../../helpers/holds.js';

/**
 * Failure and degradation behaviour: PRD FR-7 "Redis down -> new holds
 * rejected (fail closed)", plus real TTL expiry and seat-status precedence.
 */
describe('seat hold failure modes', () => {
  const config = testConfig({ AUTH_RATE_LIMIT_MAX: '1000', HOLD_RATE_LIMIT_MAX: '1000' });
  let prisma: PrismaClient;
  let redis: Redis;
  let app: SeatrushFastifyInstance;
  let showId: string;
  let seats: string[];
  let userCounter = 0;
  const newUser = async (instance: SeatrushFastifyInstance = app): Promise<TestUser> => {
    userCounter += 1;
    return registerUser(instance, `phase3.fail${userCounter}@test.local`);
  };

  beforeAll(async () => {
    await assertInfrastructureReady(config);
    prisma = testPrisma(config);
    redis = createRedisClient(config);
    app = buildServer({ config, prisma, redis });
    await app.ready();
    ({ showId, seats } = await createIsolatedShow(prisma, 'failure-modes'));
  });

  afterAll(async () => {
    await app?.close();
    await clearAllHolds(redis, showId);
    await prisma?.bookingSeat.deleteMany({ where: { showId } });
    await prisma?.booking.deleteMany({ where: { showId } });
    await prisma?.show.deleteMany({ where: { id: showId } });
    await prisma?.user.deleteMany({ where: { email: { startsWith: 'phase3.fail' } } });
    await closeQuietly(redis);
    await closeQuietly(prisma);
  });

  beforeEach(async () => {
    await clearAllHolds(redis, showId);
    await prisma.bookingSeat.deleteMany({ where: { showId } });
    await prisma.booking.deleteMany({ where: { showId } });
  });

  it('rejects new holds with 503 when Redis is unreachable (fail closed)', async () => {
    // A second server wired to a dead Redis port. The hold path must refuse
    // rather than pretend the seats are free and hand out phantom holds.
    const deadConfig = testConfig({
      REDIS_URL: 'redis://127.0.0.1:63999',
      HEALTH_CHECK_TIMEOUT_MS: '300',
    });
    const deadRedis = createRedisClient(deadConfig);
    const deadApp = buildServer({ config: deadConfig, prisma, redis: deadRedis });
    await deadApp.ready();

    try {
      const user = await newUser(deadApp);

      const hold = await deadApp.inject({
        method: 'POST',
        url: `/shows/${showId}/holds`,
        headers: authHeader(user),
        payload: { seatIds: [seatAt(seats, 0)] },
      });

      expect(hold.statusCode).toBe(503);
      expect(hold.json<{ error: { code: string } }>().error.code).toBe(
        ERROR_CODE_HOLD.HOLDS_UNAVAILABLE,
      );

      // The seat map must NOT report everything as AVAILABLE just because the
      // live status is unknowable: that would invite a doomed checkout.
      const seatMap = await deadApp.inject({ method: 'GET', url: `/shows/${showId}/seats` });
      expect(seatMap.statusCode).toBe(503);
      expect(seatMap.json<{ error: { code: string } }>().error.code).toBe('SERVICE_UNAVAILABLE');
    } finally {
      await deadApp.close();
      await closeQuietly(deadRedis);
    }
  });

  it('prefers BOOKED over HELD when a seat is somehow both', async () => {
    const user = await newUser();

    // Hold first, then book the same seat directly in Postgres, then recreate
    // the hold lock so the seat is simultaneously BOOKED and HELD.
    const response = await app.inject({
      method: 'POST',
      url: `/shows/${showId}/holds`,
      headers: authHeader(user),
      payload: { seatIds: [seatAt(seats, 0)] },
    });
    expect(response.statusCode).toBe(201);

    await prisma.booking.create({
      data: {
        userId: user.userId,
        showId,
        status: 'CONFIRMED',
        totalAmountPaise: 50000,
        expiresAt: new Date(Date.now() + 3_600_000),
        seats: {
          create: { showId, seatId: seatAt(seats, 0), status: 'CONFIRMED', pricePaise: 50000 },
        },
      },
    });

    const seatMap = await app.inject({ method: 'GET', url: `/shows/${showId}/seats` });
    const body = seatMap.json<{ seats: { id: string; status: string }[] }>();

    // Postgres is the source of truth, so BOOKED wins over HELD.
    expect(body.seats.find((seat) => seat.id === seatAt(seats, 0))?.status).toBe('BOOKED');
  });

  it('frees a seat automatically once the hold TTL really expires', async () => {
    // A 5 second TTL is the lowest the validator accepts, and long enough to
    // prove the Redis expiry is what releases the seat.
    const shortLived = testConfig({
      AUTH_RATE_LIMIT_MAX: '1000',
      HOLD_RATE_LIMIT_MAX: '1000',
      HOLD_TTL_SECONDS: '5',
    });
    const shortRedis = createRedisClient(shortLived);
    const shortApp = buildServer({ config: shortLived, prisma, redis: shortRedis });
    await shortApp.ready();

    try {
      await clearAllHolds(shortRedis, showId);
      const user = await newUser(shortApp);

      const created = await shortApp.inject({
        method: 'POST',
        url: `/shows/${showId}/holds`,
        headers: authHeader(user),
        payload: { seatIds: [seatAt(seats, 0)] },
      });
      expect(created.statusCode).toBe(201);
      const { holdId } = created.json<{ holdId: string }>();
      expect(await shortRedis.exists(seatHoldKey(showId, seatAt(seats, 0)))).toBe(1);

      // Wait out the real TTL. No test-only shortcut touches the key here: the
      // expiry is Redis itself, which is exactly what must be proven.
      await new Promise((resolve) => setTimeout(resolve, 6000));

      expect(await shortRedis.exists(seatHoldKey(showId, seatAt(seats, 0)))).toBe(0);

      const seatMap = await shortApp.inject({ method: 'GET', url: `/shows/${showId}/seats` });
      expect(
        seatMap
          .json<{ seats: { id: string; status: string }[] }>()
          .seats.find((seat) => seat.id === seatAt(seats, 0))?.status,
      ).toBe('AVAILABLE');

      // Releasing an already-expired hold is a 404, never a crash.
      const release = await shortApp.inject({
        method: 'DELETE',
        url: `/holds/${holdId}`,
        headers: authHeader(user),
      });
      expect(release.statusCode).toBe(404);

      // And the seat can be held again by somebody else.
      const other = await newUser(shortApp);
      const again = await shortApp.inject({
        method: 'POST',
        url: `/shows/${showId}/holds`,
        headers: authHeader(other),
        payload: { seatIds: [seatAt(seats, 0)] },
      });
      expect(again.statusCode).toBe(201);
    } finally {
      await shortApp.close();
      await clearAllHolds(shortRedis, showId);
      await closeQuietly(shortRedis);
    }
  });
});
