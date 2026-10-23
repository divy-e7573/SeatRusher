import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import type { ShowSeats, ShowSummary } from 'shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../../src/app.js';
import type { SeatrushFastifyInstance } from '../../../src/lib/logger.js';
import { createRedisClient, ensureRedisConnected } from '../../../src/lib/redis.js';
import {
  assertInfrastructureReady,
  closeQuietly,
  TEST_FIXTURE_SHOW_PREFIX,
  testConfig,
  testPrisma,
} from '../../helpers/test-app.js';

/**
 * Integration tests for the read APIs against real Postgres + Redis, using the
 * seeded test schema. Run `pnpm --filter api db:test:prepare` first.
 */

describe('shows read APIs', () => {
  const config = testConfig();
  let app: SeatrushFastifyInstance;
  let prisma: PrismaClient;
  let redis: Redis;
  let firstShowId: string;

  beforeAll(async () => {
    await assertInfrastructureReady(config);
    prisma = testPrisma(config);
    redis = createRedisClient(config);
    await ensureRedisConnected(redis);
    app = buildServer({ config, prisma, redis });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await closeQuietly(redis);
    await closeQuietly(prisma);
  });

  beforeEach(async () => {
    // Deterministic cache state: every assertion about availability reads from a
    // known-empty cache and a known database.
    await redis.del(`show:detail:${firstShowId ?? ''}`, `seat:layout:${firstShowId ?? ''}`);
  });

  it('GET /shows lists the three seeded shows ordered by start time', async () => {
    const response = await app.inject({ method: 'GET', url: '/shows' });
    expect(response.statusCode).toBe(200);

    const body = response.json<{ shows: ShowSummary[] }>();
    // Other suites create their own shows in this shared schema; this test is
    // about the three SEEDED shows, so fixtures are filtered out explicitly.
    const seeded = body.shows.filter((show) => !show.title.startsWith(TEST_FIXTURE_SHOW_PREFIX));
    expect(seeded.length).toBe(3);
    firstShowId = seeded[0]?.id ?? '';

    const startTimes = seeded.map((show) => new Date(show.startTime).getTime());
    expect([...startTimes].sort((a, b) => a - b)).toEqual(startTimes);
    for (const show of seeded) {
      expect(show.totalSeats).toBe(150);
      expect(show.availableSeats).toBe(150);
      expect(show.prices).toEqual(
        expect.arrayContaining([
          { category: 'PREMIUM', amountPaise: 35000 },
          { category: 'REGULAR', amountPaise: 20000 },
        ]),
      );
      expect(Number.isNaN(Date.parse(show.startTime))).toBe(false);
    }
  });

  it('GET /shows/:id returns the show with its venue, screen and availability', async () => {
    const response = await app.inject({ method: 'GET', url: `/shows/${firstShowId}` });
    expect(response.statusCode).toBe(200);

    const body = response.json<ShowSummary>();
    expect(body.id).toBe(firstShowId);
    expect(body.venueName).toBe('PVR Nexus Mall');
    expect(body.screenName).toBe('Screen 1 - IMAX');
    expect(body.totalSeats).toBe(150);
    expect(body.availableSeats).toBe(150);
  });

  it('GET /shows/:id/seats returns the 150-seat layout with categories and prices', async () => {
    const response = await app.inject({ method: 'GET', url: `/shows/${firstShowId}/seats` });
    expect(response.statusCode).toBe(200);

    const body = response.json<ShowSeats>();
    expect(body.totalSeats).toBe(150);
    expect(body.seats).toHaveLength(150);

    const rows = new Set(body.seats.map((seat) => seat.rowLabel));
    expect([...rows].sort()).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']);
    expect(body.seats.filter((seat) => seat.category === 'PREMIUM')).toHaveLength(45);
    expect(body.seats.filter((seat) => seat.category === 'REGULAR')).toHaveLength(105);

    const seatA1 = body.seats.find((seat) => seat.rowLabel === 'A' && seat.seatNumber === 1);
    expect(seatA1).toMatchObject({ category: 'PREMIUM', pricePaise: 35000, status: 'AVAILABLE' });
    const seatJ15 = body.seats.find((seat) => seat.rowLabel === 'J' && seat.seatNumber === 15);
    expect(seatJ15).toMatchObject({ category: 'REGULAR', pricePaise: 20000 });
  });

  it('reflects a booked seat as BOOKED and reduces the available count', async () => {
    const userId = '33333333-3333-4333-8333-333333333333';
    const secondShowId = '22222222-2222-4222-8222-222222222221';
    const targetSeat = await prisma.seat.findFirstOrThrow({
      where: { screen: { shows: { some: { id: secondShowId } } } },
    });

    await prisma.user.create({
      data: { id: userId, email: 'shows-api@test.local', passwordHash: 'x', displayName: 'Test' },
    });
    const booking = await prisma.booking.create({
      data: {
        userId,
        showId: secondShowId,
        status: 'CONFIRMED',
        totalAmountPaise: 20000,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        seats: {
          create: {
            showId: secondShowId,
            seatId: targetSeat.id,
            status: 'CONFIRMED',
            pricePaise: 20000,
          },
        },
      },
    });

    try {
      await redis.del(`show:detail:${secondShowId}`, `seat:layout:${secondShowId}`);
      const seatsResponse = await app.inject({
        method: 'GET',
        url: `/shows/${secondShowId}/seats`,
      });
      const seatsBody = seatsResponse.json<ShowSeats>();
      expect(seatsBody.seats.find((seat) => seat.id === targetSeat.id)?.status).toBe('BOOKED');
      expect(seatsBody.availableSeats).toBe(149);

      const detail = await app.inject({ method: 'GET', url: `/shows/${secondShowId}` });
      expect(detail.json<ShowSummary>().availableSeats).toBe(149);
    } finally {
      await prisma.booking.delete({ where: { id: booking.id } });
      await prisma.user.delete({ where: { id: userId } });
      await redis.del(`show:detail:${secondShowId}`, `seat:layout:${secondShowId}`);
    }
  });

  it('GET /shows/:id returns 404 for a well-formed but unknown id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/shows/99999999-9999-4999-8999-999999999999',
    });
    expect(response.statusCode).toBe(404);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('GET /shows/:id returns 400 for a malformed id', async () => {
    for (const id of ['not-a-uuid', '123', '%20']) {
      const response = await app.inject({ method: 'GET', url: `/shows/${id}` });
      expect(response.statusCode).toBe(400);
      const body = response.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('BAD_REQUEST');
    }
  });
});
