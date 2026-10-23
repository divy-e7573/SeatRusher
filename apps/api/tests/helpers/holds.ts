import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { SeatrushFastifyInstance } from '../../src/lib/logger.js';
import { ensureRedisConnected } from '../../src/lib/redis.js';
import { seatHoldKeyPattern } from '../../src/lib/redis-keys.js';
import type { AuthResponse } from 'shared';
import { TEST_FIXTURE_SHOW_PREFIX } from './test-app.js';

/**
 * Helpers shared by the hold test suites.
 *
 * Holds live in Redis, so every suite must wipe them between tests; leaking a
 * hold into the next test would make it fail for the wrong reason.
 */

export interface TestUser {
  userId: string;
  accessToken: string;
}

/**
 * Registers a throwaway user through the real endpoint and returns a ready
 * bearer token, so tests exercise the same auth path a client would.
 */
export async function registerUser(app: SeatrushFastifyInstance, email: string): Promise<TestUser> {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password: 'hold test password', displayName: 'Hold Tester' },
  });
  if (response.statusCode !== 201) {
    throw new Error(
      `Could not register test user ${email}: HTTP ${response.statusCode} ${response.body}`,
    );
  }
  const body = response.json<AuthResponse>();
  return { userId: body.user.id, accessToken: body.accessToken };
}

export function authHeader(user: TestUser): Record<string, string> {
  return { authorization: `Bearer ${user.accessToken}` };
}

/**
 * Deletes the hold artefacts of ONE show with SCAN, never KEYS.
 *
 * Scoped to a show on purpose: Vitest runs test FILES in parallel, and a
 * global `hold:*` wipe would delete a hold another suite created microseconds
 * earlier, failing it for the wrong reason. Every hold suite therefore owns a
 * private show, and `hold:{showId}:*` cannot reach anyone else's locks.
 *
 * KEYS blocks the Redis event loop for the whole keyspace, which would be
 * self-defeating in the one datastore whose latency we are trying to protect.
 */
export async function clearAllHolds(redis: Redis, showId: string): Promise<void> {
  await ensureRedisConnected(redis);
  for (const pattern of [seatHoldKeyPattern(showId)]) {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== '0');
  }
}

/**
 * Creates a show of its own so each hold suite is isolated from the others'
 * Redis keys, and returns its id together with its 150 physical seat ids.
 */
export async function createIsolatedShow(
  prisma: PrismaClient,
  label: string,
): Promise<{ showId: string; seats: string[] }> {
  const screen = await prisma.screen.findFirstOrThrow();
  const show = await prisma.show.create({
    data: {
      id: randomUUID(),
      title: `${TEST_FIXTURE_SHOW_PREFIX}${label}`,
      screenId: screen.id,
      startTime: new Date('2030-01-01T10:00:00Z'),
      prices: {
        create: [
          { category: 'REGULAR', amountPaise: 25000 },
          { category: 'PREMIUM', amountPaise: 45000 },
          { category: 'RECLINER', amountPaise: 60000 },
        ],
      },
    },
  });

  return { showId: show.id, seats: await seatIdsForShow(prisma, show.id) };
}

/**
 * Reads one seat id out of a layout.
 *
 * `noUncheckedIndexedAccess` is on, so `seats[0]` is `string | undefined`. A
 * helper that throws turns a mis-seeded layout into a clear failure instead of
 * a cascade of confusing 400s.
 */
export function seatAt(seats: string[], index: number): string {
  const seat = seats[index];
  if (seat === undefined) {
    throw new Error(`Seed did not provide a seat at index ${index}`);
  }
  return seat;
}

/** Seat ids of a show, in layout order. */
export async function seatIdsForShow(prisma: PrismaClient, showId: string): Promise<string[]> {
  const show = await prisma.show.findUniqueOrThrow({
    where: { id: showId },
    select: { screenId: true },
  });
  const seats = await prisma.seat.findMany({
    where: { screenId: show.screenId },
    orderBy: [{ rowLabel: 'asc' }, { seatNumber: 'asc' }],
    select: { id: true },
  });
  return seats.map((seat) => seat.id);
}
