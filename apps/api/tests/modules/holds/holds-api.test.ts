import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../../src/app.js';
import type { SeatrushFastifyInstance } from '../../../src/lib/logger.js';
import { createRedisClient, ensureRedisConnected } from '../../../src/lib/redis.js';
import { holdMetaKey, seatHoldKey, userHoldsKey } from '../../../src/lib/redis-keys.js';
import type { Hold } from 'shared';
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
 * Seat-hold endpoint integration tests.
 *
 * Every assertion runs against real PostgreSQL and a real Redis: the whole
 * point of this phase is the interaction between a durable booking and an
 * ephemeral lock, which a mock cannot reproduce.
 */
describe('seat hold endpoints', () => {
  const config = testConfig({ AUTH_RATE_LIMIT_MAX: '1000', HOLD_RATE_LIMIT_MAX: '1000' });
  let app: SeatrushFastifyInstance;
  let prisma: PrismaClient;
  let redis: Redis;

  let showId: string;
  let seats: string[];

  let userCounter = 0;
  async function newUser(): Promise<TestUser> {
    userCounter += 1;
    return registerUser(app, `phase3.api${userCounter}@test.local`);
  }

  beforeAll(async () => {
    await assertInfrastructureReady(config);
    prisma = testPrisma(config);
    redis = createRedisClient(config);
    app = buildServer({ config, prisma, redis });
    await app.ready();
    ({ showId, seats } = await createIsolatedShow(prisma, 'api'));
  });

  afterAll(async () => {
    await app?.close();
    await clearAllHolds(redis, showId);
    await prisma?.bookingSeat.deleteMany({ where: { showId } });
    await prisma?.booking.deleteMany({ where: { showId } });
    await prisma?.show.deleteMany({ where: { id: showId } });
    await prisma?.user.deleteMany({ where: { email: { startsWith: 'phase3.' } } });
    await closeQuietly(redis);
    await closeQuietly(prisma);
  });

  beforeEach(async () => {
    await clearAllHolds(redis, showId);
    await prisma.bookingSeat.deleteMany({ where: { showId } });
    await prisma.booking.deleteMany({ where: { showId } });
  });

  const holdSeats = (user: TestUser, seatIds: string[]) =>
    app.inject({
      method: 'POST',
      url: `/shows/${showId}/holds`,
      headers: authHeader(user),
      payload: { seatIds },
    });

  const release = (user: TestUser, holdId: string) =>
    app.inject({ method: 'DELETE', url: `/holds/${holdId}`, headers: authHeader(user) });

  const seatStatus = async (seatId: string): Promise<string> => {
    const response = await app.inject({ method: 'GET', url: `/shows/${showId}/seats` });
    const body = response.json<{ seats: { id: string; status: string }[] }>();
    return body.seats.find((seat) => seat.id === seatId)?.status ?? 'MISSING';
  };

  /** Hold ids currently recorded for a user, read straight from the ZSET. */
  const heldIdsFor = async (user: TestUser): Promise<string[]> => {
    await ensureRedisConnected(redis);
    // ZRANGEBYSCORE over the full range: ioredis 6's ZRANGE overloads reject a
    // numeric stop in TypeScript, and this reads the members in expiry order.
    const members = await redis.zrangebyscore(userHoldsKey(user.userId, showId), '-inf', '+inf');
    return members.map((member) => member.split(':')[0] ?? '');
  };

  it('refuses to hold a seat without a valid access token', async () => {
    const anonymous = await app.inject({
      method: 'POST',
      url: `/shows/${showId}/holds`,
      payload: { seatIds: [seatAt(seats, 0)] },
    });
    expect(anonymous.statusCode).toBe(401);

    const bogus = await app.inject({
      method: 'POST',
      url: `/shows/${showId}/holds`,
      headers: { authorization: 'Bearer not.a.real.token' },
      payload: { seatIds: [seatAt(seats, 0)] },
    });
    expect(bogus.statusCode).toBe(401);
  });

  it('creates a hold and reports a server-generated expiry', async () => {
    const user = await newUser();
    const before = Date.now();
    const response = await holdSeats(user, [seatAt(seats, 0), seatAt(seats, 1)]);

    expect(response.statusCode).toBe(201);
    const body = response.json<Hold>();
    expect(body.showId).toBe(showId);
    expect(body.seatIds).toEqual([seatAt(seats, 0), seatAt(seats, 1)]);
    expect(body.ttlSeconds).toBe(config.hold.ttlSeconds);

    // Invariant 7: the expiry comes from the server clock, not the client.
    const expiresAt = Date.parse(body.expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(before + config.hold.ttlSeconds * 1000 - 5000);

    await ensureRedisConnected(redis);
    expect(await redis.get(seatHoldKey(showId, seatAt(seats, 0)))).toBe(
      `${user.userId}:${body.holdId}`,
    );
    const ttl = await redis.ttl(seatHoldKey(showId, seatAt(seats, 0)));
    expect(ttl).toBeGreaterThan(config.hold.ttlSeconds - 10);
    expect(await redis.exists(holdMetaKey(body.holdId))).toBe(1);
  });

  it('marks held seats as HELD on the seat map and leaves the rest AVAILABLE', async () => {
    const user = await newUser();
    await holdSeats(user, [seatAt(seats, 0)]);

    expect(await seatStatus(seatAt(seats, 0))).toBe('HELD');
    expect(await seatStatus(seatAt(seats, 1))).toBe('AVAILABLE');
  });

  it('rejects a malformed body, an unknown seat, and a repeated seat', async () => {
    const user = await newUser();

    expect((await holdSeats(user, [])).statusCode).toBe(400);
    expect((await holdSeats(user, ['not-a-uuid'])).statusCode).toBe(400);
    expect((await holdSeats(user, [seatAt(seats, 0), seatAt(seats, 0)])).statusCode).toBe(400);

    const unknownSeat = await holdSeats(user, ['99999999-9999-4999-8999-999999999999']);
    expect(unknownSeat.statusCode).toBe(400);
    expect(unknownSeat.json<{ error: { code: string } }>().error.code).toBe('BAD_REQUEST');
  });

  it('rejects more than six seats in one request', async () => {
    const user = await newUser();
    expect((await holdSeats(user, seats.slice(0, 7))).statusCode).toBe(400);
  });

  it('returns 404 for an unknown show', async () => {
    const user = await newUser();
    const response = await app.inject({
      method: 'POST',
      url: '/shows/99999999-9999-4999-8999-999999999999/holds',
      headers: authHeader(user),
      payload: { seatIds: [seatAt(seats, 0)] },
    });
    expect(response.statusCode).toBe(404);
  });

  it('returns 409 when another user already holds a seat', async () => {
    const first = await newUser();
    const second = await newUser();

    expect((await holdSeats(first, [seatAt(seats, 0)])).statusCode).toBe(201);

    const conflict = await holdSeats(second, [seatAt(seats, 0)]);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<{ error: { code: string } }>().error.code).toBe('SEAT_CONFLICT');
  });

  it('is all-or-nothing: one taken seat means NO seat is held', async () => {
    const first = await newUser();
    const second = await newUser();
    await holdSeats(first, [seatAt(seats, 1)]);

    const response = await holdSeats(second, [
      seatAt(seats, 0),
      seatAt(seats, 1),
      seatAt(seats, 2),
    ]);
    expect(response.statusCode).toBe(409);

    await ensureRedisConnected(redis);
    expect(await redis.exists(seatHoldKey(showId, seatAt(seats, 0)))).toBe(0);
    expect(await redis.exists(seatHoldKey(showId, seatAt(seats, 2)))).toBe(0);
    expect(await seatStatus(seatAt(seats, 0))).toBe('AVAILABLE');
    expect(await seatStatus(seatAt(seats, 2))).toBe('AVAILABLE');
  });

  it('caps the user at six held seats per show across SEPARATE holds', async () => {
    const user = await newUser();

    expect((await holdSeats(user, seats.slice(0, 4))).statusCode).toBe(201);
    expect((await holdSeats(user, seats.slice(4, 6))).statusCode).toBe(201);

    const seventh = await holdSeats(user, [seatAt(seats, 6)]);
    expect(seventh.statusCode).toBe(409);
    expect(seventh.json<{ error: { code: string } }>().error.code).toBe('HOLD_LIMIT_EXCEEDED');

    await ensureRedisConnected(redis);
    expect(await redis.exists(seatHoldKey(showId, seatAt(seats, 6)))).toBe(0);
    // Both holds are tracked independently, so the cap spans separate requests.
    expect(await heldIdsFor(user)).toHaveLength(2);
  });

  it('refuses to hold a seat that is already booked in Postgres', async () => {
    const user = await newUser();
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

    const response = await holdSeats(user, [seatAt(seats, 0)]);
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('SEAT_CONFLICT');
    // Postgres wins: no Redis lock was created for a sold seat.
    expect(await redis.exists(seatHoldKey(showId, seatAt(seats, 0)))).toBe(0);
  });

  it('lets only the owner release, and reports 404 for anyone else', async () => {
    const owner = await newUser();
    const stranger = await newUser();
    const { holdId } = (await holdSeats(owner, [seatAt(seats, 0), seatAt(seats, 1)])).json<Hold>();

    const denied = await release(stranger, holdId);
    expect(denied.statusCode).toBe(404);
    expect(denied.json<{ error: { code: string } }>().error.code).toBe('HOLD_NOT_FOUND');

    // The denial must not have freed anything.
    expect(await redis.exists(seatHoldKey(showId, seatAt(seats, 0)))).toBe(1);

    expect((await release(owner, holdId)).statusCode).toBe(204);
    expect(await redis.exists(seatHoldKey(showId, seatAt(seats, 0)))).toBe(0);
    expect(await redis.exists(seatHoldKey(showId, seatAt(seats, 1)))).toBe(0);
    expect(await redis.exists(holdMetaKey(holdId))).toBe(0);
  });

  it('treats a repeated release as not found', async () => {
    const owner = await newUser();
    const { holdId } = (await holdSeats(owner, [seatAt(seats, 0)])).json<Hold>();

    expect((await release(owner, holdId)).statusCode).toBe(204);
    expect((await release(owner, holdId)).statusCode).toBe(404);
  });

  it('frees the user allowance again once every hold is released', async () => {
    const user = await newUser();
    expect((await holdSeats(user, seats.slice(0, 6))).statusCode).toBe(201);
    expect((await holdSeats(user, [seatAt(seats, 6)])).statusCode).toBe(409);

    for (const holdId of await heldIdsFor(user)) {
      expect((await release(user, holdId)).statusCode).toBe(204);
    }

    expect((await holdSeats(user, [seatAt(seats, 6)])).statusCode).toBe(201);
  });

  it('drops expired hold bookkeeping so it cannot consume the allowance', async () => {
    const user = await newUser();
    await ensureRedisConnected(redis);

    // Exactly what a crashed process leaves behind: the seat keys are gone but
    // the ZSET entry is still sitting there.
    const stale = '00000000-0000-4000-8000-000000000000:6';
    await redis.zadd(userHoldsKey(user.userId, showId), Date.now() - 60_000, stale);

    const response = await holdSeats(user, [seatAt(seats, 0)]);
    expect(response.statusCode).toBe(201);
    expect(await redis.zscore(userHoldsKey(user.userId, showId), stale)).toBeNull();
  });

  it('ignores a client-supplied userId and never echoes another identity', async () => {
    const user = await newUser();
    const other = await newUser();

    const response = await app.inject({
      method: 'POST',
      url: `/shows/${showId}/holds`,
      headers: authHeader(user),
      payload: { seatIds: [seatAt(seats, 0)], userId: other.userId } as unknown as {
        seatIds: string[];
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<Hold>();
    expect(await redis.get(seatHoldKey(showId, seatAt(seats, 0)))).toBe(
      `${user.userId}:${body.holdId}`,
    );
    expect(JSON.stringify(body)).not.toContain(other.userId);
  });
});
