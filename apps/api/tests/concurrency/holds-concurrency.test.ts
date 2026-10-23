import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/app.js';
import type { SeatrushFastifyInstance } from '../../src/lib/logger.js';
import { createRedisClient, ensureRedisConnected } from '../../src/lib/redis.js';
import { seatHoldKey } from '../../src/lib/redis-keys.js';
import type { Hold } from 'shared';
import {
  assertInfrastructureReady,
  closeQuietly,
  testConfig,
  testPrisma,
} from '../helpers/test-app.js';
import {
  authHeader,
  clearAllHolds,
  createIsolatedShow,
  registerUser,
  seatAt,
  type TestUser,
} from '../helpers/holds.js';

/**
 * The tests that justify the whole design.
 *
 * AGENTS.md requires concurrency tests for hold logic: N parallel attempts
 * via Promise.all, asserting exactly 1 success. Every request here is sent
 * simultaneously, so without the Lua script several of them would read the
 * seat as free before any of them wrote it.
 */
describe('seat hold concurrency', () => {
  const config = testConfig({ AUTH_RATE_LIMIT_MAX: '10000', HOLD_RATE_LIMIT_MAX: '10000' });
  let app: SeatrushFastifyInstance;
  let prisma: PrismaClient;
  let redis: Redis;
  let showId: string;
  let seats: string[];

  let userCounter = 0;
  const newUser = async (): Promise<TestUser> => {
    userCounter += 1;
    return registerUser(app, `phase3.conc${userCounter}@test.local`);
  };

  beforeAll(async () => {
    await assertInfrastructureReady(config);
    prisma = testPrisma(config);
    redis = createRedisClient(config);
    app = buildServer({ config, prisma, redis });
    await app.ready();
    ({ showId, seats } = await createIsolatedShow(prisma, 'concurrency'));
  });

  afterAll(async () => {
    await app?.close();
    await clearAllHolds(redis, showId);
    await prisma?.show.deleteMany({ where: { id: showId } });
    await prisma?.user.deleteMany({ where: { email: { startsWith: 'phase3.conc' } } });
    await closeQuietly(redis);
    await closeQuietly(prisma);
  });

  beforeEach(async () => {
    await clearAllHolds(redis, showId);
  });

  const holdSeats = (user: TestUser, seatIds: string[]) =>
    app.inject({
      method: 'POST',
      url: `/shows/${showId}/holds`,
      headers: authHeader(user),
      payload: { seatIds },
    });

  it('gives one contested seat to exactly ONE of 12 simultaneous users', async () => {
    const CONTENDERS = 12;
    const users = await Promise.all(Array.from({ length: CONTENDERS }, () => newUser()));

    const responses = await Promise.all(users.map((user) => holdSeats(user, [seatAt(seats, 0)])));
    const created = responses.filter((response) => response.statusCode === 201);
    const conflicts = responses.filter((response) => response.statusCode === 409);

    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(CONTENDERS - 1);
    for (const response of conflicts) {
      expect(response.json<{ error: { code: string } }>().error.code).toBe('SEAT_CONFLICT');
    }

    // Redis holds exactly one owner, and it is the request that got 201.
    await ensureRedisConnected(redis);
    const winnerIndex = responses.findIndex((response) => response.statusCode === 201);
    const winner = users[winnerIndex]!;
    const winnerHoldId = created[0]!.json<Hold>().holdId;
    expect(await redis.get(seatHoldKey(showId, seatAt(seats, 0)))).toBe(
      `${winner.userId}:${winnerHoldId}`,
    );
  });

  it('lets only one of many users win a 4-seat overlapping request', async () => {
    const CONTENDERS = 10;
    const users = await Promise.all(Array.from({ length: CONTENDERS }, () => newUser()));
    // Everyone asks for the same 4 seats, in the same order.
    const contested = seats.slice(1, 5);

    const responses = await Promise.all(users.map((user) => holdSeats(user, contested)));
    const created = responses.filter((response) => response.statusCode === 201);
    const conflicts = responses.filter((response) => response.statusCode === 409);

    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(CONTENDERS - 1);

    await ensureRedisConnected(redis);
    // The losers left no partial hold behind: all 4 keys belong to the winner.
    const { holdId } = created[0]!.json<Hold>();
    for (const seatId of contested) {
      expect(await redis.get(seatHoldKey(showId, seatId))).toContain(`:${holdId}`);
    }
  });

  it('never lets parallel holds exceed the six-seat cap for one user', async () => {
    const user = await newUser();

    // Five concurrent 3-seat requests would total 15 seats if the cap were not
    // evaluated atomically inside the script.
    const batches = [
      seats.slice(0, 3),
      seats.slice(3, 6),
      seats.slice(10, 13),
      seats.slice(13, 16),
      seats.slice(16, 19),
    ];
    const responses = await Promise.all(batches.map((seatIds) => holdSeats(user, seatIds)));

    const created = responses.filter((response) => response.statusCode === 201);
    const rejected = responses.filter((response) => response.statusCode === 409);
    const grantedSeats = created.reduce(
      (total, response) => total + response.json<Hold>().seatIds.length,
      0,
    );

    expect(grantedSeats).toBeLessThanOrEqual(6);
    expect(created.length).toBeGreaterThan(0);
    expect(rejected.length).toBe(batches.length - created.length);
  });

  it('keeps two users from double-claiming under parallel load and reports it on the map', async () => {
    const CONTENDERS = 8;
    const users = await Promise.all(Array.from({ length: CONTENDERS }, () => newUser()));

    const responses = await Promise.all(
      users.map((user, index) => holdSeats(user, [seatAt(seats, 20 + index)])),
    );
    expect(responses.filter((response) => response.statusCode === 201)).toHaveLength(CONTENDERS);

    // Now every user also asks for a common seat, all at the same time.
    const contested = await Promise.all(users.map((user) => holdSeats(user, [seatAt(seats, 30)])));
    expect(contested.filter((response) => response.statusCode === 201)).toHaveLength(1);
    expect(contested.filter((response) => response.statusCode === 409)).toHaveLength(
      CONTENDERS - 1,
    );

    const seatsResponse = await app.inject({ method: 'GET', url: `/shows/${showId}/seats` });
    const body = seatsResponse.json<{
      availableSeats: number;
      seats: { id: string; status: string }[];
    }>();

    // 8 private holds + 1 contested hold = 9 seats no longer available.
    expect(body.seats.filter((seat) => seat.status === 'HELD')).toHaveLength(9);
    expect(body.availableSeats).toBe(body.seats.length - 9);
  });
});
