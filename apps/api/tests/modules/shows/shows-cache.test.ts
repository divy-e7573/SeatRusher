import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createShowCache } from '../../../src/modules/shows/shows-cache.js';
import { createShowsRepository } from '../../../src/modules/shows/shows-repository.js';
import { createShowsService } from '../../../src/modules/shows/shows-service.js';
import { createLogger } from '../../../src/lib/logger.js';
import { createRedisClient } from '../../../src/lib/redis.js';
import { seatLayoutKey, showDetailKey } from '../../../src/lib/redis-keys.js';
import {
  assertInfrastructureReady,
  closeQuietly,
  testConfig,
  testPrisma,
} from '../../helpers/test-app.js';

/**
 * Cache-aside behaviour, verified against the real Redis container:
 * keys are written, TTLs match the policy, and invalidation helpers actually
 * force the next read back to Postgres.
 */
describe('shows cache', () => {
  const config = testConfig();
  const logger = createLogger(config);
  const showId = '22222222-2222-4222-8222-222222222220';
  let prisma: PrismaClient;
  let redis: Redis;

  beforeAll(async () => {
    await assertInfrastructureReady(config);
    prisma = testPrisma(config);
    redis = createRedisClient(config);
  });

  afterAll(async () => {
    await closeQuietly(redis);
    await closeQuietly(prisma);
  });

  function makeService() {
    return createShowsService({
      repository: createShowsRepository(prisma),
      cache: createShowCache(redis, logger),
    });
  }

  it('writes show:detail with a 5 minute TTL and seat:layout with no TTL', async () => {
    const cache = createShowCache(redis, logger);
    await cache.invalidateShow(showId);
    const service = makeService();

    await service.getShowDetail(showId);
    await service.getShowSeats(showId);

    const detailTtl = await redis.ttl(showDetailKey(showId));
    const layoutTtl = await redis.ttl(seatLayoutKey(showId));
    expect(detailTtl).toBeGreaterThan(0);
    expect(detailTtl).toBeLessThanOrEqual(300);
    // -1 = key exists but has no expiry, which is exactly the layout policy.
    expect(layoutTtl).toBe(-1);
  });

  it('serves a mutated show from cache until the invalidation helper runs', async () => {
    const cache = createShowCache(redis, logger);
    await cache.invalidateShow(showId);
    const service = makeService();

    const original = await service.getShowDetail(showId);
    const renamed = `${original.title} (Director's Cut)`;
    await prisma.show.update({ where: { id: showId }, data: { title: renamed } });

    try {
      // Still the cached value: proves the second request did not hit Postgres.
      expect((await service.getShowDetail(showId)).title).toBe(original.title);

      await cache.invalidateShow(showId);
      expect((await service.getShowDetail(showId)).title).toBe(renamed);
    } finally {
      await prisma.show.update({ where: { id: showId }, data: { title: original.title } });
      await cache.invalidateShow(showId);
    }
  });

  it('keeps seat status live even while the layout is served from cache', async () => {
    const cache = createShowCache(redis, logger);
    await cache.invalidateShow(showId);
    const service = makeService();

    const seats = await service.getShowSeats(showId);
    expect(await redis.exists(seatLayoutKey(showId))).toBe(1);

    const userId = '33333333-3333-4333-8333-333333333334';
    const target = seats.seats[0];
    expect(target).toBeDefined();
    await prisma.user.create({
      data: { id: userId, email: 'cache@test.local', passwordHash: 'x', displayName: 'Test' },
    });
    const booking = await prisma.booking.create({
      data: {
        userId,
        showId: showId,
        status: 'PENDING',
        totalAmountPaise: target?.pricePaise ?? 0,
        expiresAt: new Date(Date.now() + 600_000),
        seats: {
          create: {
            showId,
            seatId: target?.id ?? '',
            status: 'PENDING',
            pricePaise: target?.pricePaise ?? 0,
          },
        },
      },
    });

    try {
      // No cache invalidation: the layout entry is still cached, yet the seat
      // flips to BOOKED because status is always read live from Postgres.
      const after = await service.getShowSeats(showId);
      expect(after.seats.find((seat) => seat.id === target?.id)?.status).toBe('BOOKED');
      expect(after.availableSeats).toBe(149);
    } finally {
      await prisma.booking.delete({ where: { id: booking.id } });
      await prisma.user.delete({ where: { id: userId } });
    }
  });

  it('clearAllShowCaches removes every show detail and layout key', async () => {
    const cache = createShowCache(redis, logger);
    const service = makeService();
    await service.getShowDetail(showId);
    await service.getShowSeats(showId);

    const removed = await cache.clearAllShowCaches();
    expect(removed).toBeGreaterThanOrEqual(2);
    expect(await redis.exists(showDetailKey(showId))).toBe(0);
    expect(await redis.exists(seatLayoutKey(showId))).toBe(0);
  });
});
