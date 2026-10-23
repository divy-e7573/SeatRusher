import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDatabase } from '../../prisma/seed.js';
import {
  assertInfrastructureReady,
  closeQuietly,
  TEST_FIXTURE_SHOW_PREFIX,
  testConfig,
  testPrisma,
} from '../helpers/test-app.js';

describe('seed script', () => {
  const config = testConfig();
  let prisma: PrismaClient;

  beforeAll(async () => {
    await assertInfrastructureReady(config);
    prisma = testPrisma(config);
  });

  afterAll(async () => {
    await closeQuietly(prisma);
  });

  it('is idempotent: running twice leaves exactly 1 venue, 1 screen, 150 seats and 3 shows', async () => {
    const first = await seedDatabase(config.databaseUrl);
    const second = await seedDatabase(config.databaseUrl);

    expect(first.seatCount).toBe(150);
    expect(first.showIds).toEqual(second.showIds);

    const screenId = first.screenId;
    expect(await prisma.venue.count({ where: { id: first.venueId } })).toBe(1);
    expect(await prisma.screen.count()).toBe(1);
    expect(await prisma.seat.count({ where: { screenId } })).toBe(150);
    // Other suites own their own shows in this shared schema and may be
    // mid-flight here, so count the SEEDED shows rather than every row.
    const fixtureShows = await prisma.show.count({
      where: { title: { startsWith: TEST_FIXTURE_SHOW_PREFIX } },
    });
    expect((await prisma.show.count()) - fixtureShows).toBe(3);
    // Same reason for prices: a suite-owned show brings its own price rows.
    expect(await prisma.showPrice.count({ where: { showId: { in: first.showIds } } })).toBe(6);
  });

  it('seeds 15 seats in each of the 10 rows A-J with premium front rows', async () => {
    const seats = await prisma.seat.findMany({
      orderBy: [{ rowLabel: 'asc' }, { seatNumber: 'asc' }],
    });
    const perRow = new Map<string, number>();
    for (const seat of seats) {
      perRow.set(seat.rowLabel, (perRow.get(seat.rowLabel) ?? 0) + 1);
    }
    expect(perRow.size).toBe(10);
    for (const count of perRow.values()) {
      expect(count).toBe(15);
    }
    const premium = seats.filter((seat) => seat.category === 'PREMIUM');
    expect(new Set(premium.map((seat) => seat.rowLabel))).toEqual(new Set(['A', 'B', 'C']));
  });
});
