/**
 * Idempotent seed data: one venue, one screen with 150 seats (rows A-J x 15),
 * three shows with per-category prices.
 *
 * Every write is an upsert keyed on a natural unique column, so running the seed
 * twice leaves exactly the same rows (no duplicates). Re-running is also what
 * refreshes the deterministic ids the tests rely on.
 */

import { pathToFileURL } from 'node:url';
import { PrismaClient, type Prisma, type SeatCategory } from '@prisma/client';

const VENUE = {
  name: 'PVR Nexus Mall',
  address: 'Dr. Rajkumar Road, Rajajinagar',
  city: 'Bengaluru',
} as const;

const SCREEN = { name: 'Screen 1 - IMAX' } as const;

/** Rows A-C are premium (front block); D-J are regular. 3 x 15 + 7 x 15 = 150. */
const ROWS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'] as const;
const SEATS_PER_ROW = 15;
const PREMIUM_ROWS = new Set(['A', 'B', 'C']);

/** Prices in paise (INR minor units): premium Rs 350, regular Rs 200. */
const PRICES: Record<SeatCategory, number> = {
  PREMIUM: 35000,
  REGULAR: 20000,
  RECLINER: 45000,
};

/** Show start times are generated relative to "now" so demo data is always current. */
function showSchedule(): { title: string; synopsis: string; inHours: number }[] {
  return [
    {
      title: 'Interstellar Echo (Re-release)',
      synopsis: 'A crew of explorers crosses a wormhole to find humanity a second home.',
      inHours: 2,
    },
    {
      title: 'Mumbai Nights',
      synopsis: 'A taxi driver and a runaway artist share one long night out.',
      inHours: 6,
    },
    {
      title: 'The Last Signal',
      synopsis: 'A radio astronomer receives a broadcast that should not exist.',
      inHours: 26,
    },
  ];
}

export interface SeedResult {
  venueId: string;
  screenId: string;
  showIds: string[];
  seatCount: number;
}

/**
 * Runs the seed against an explicit database URL.
 *
 * The URL is a parameter (not read from the environment inside Prisma) so the
 * same function seeds the dev database, the test schema, or CI.
 */
export async function seedDatabase(databaseUrl: string): Promise<SeedResult> {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const venue = await prisma.venue.upsert({
      where: { id: '11111111-1111-4111-8111-111111111111' },
      update: { name: VENUE.name, address: VENUE.address, city: VENUE.city },
      create: {
        id: '11111111-1111-4111-8111-111111111111',
        name: VENUE.name,
        address: VENUE.address,
        city: VENUE.city,
      },
    });

    const screen = await prisma.screen.upsert({
      where: { venueId_name: { venueId: venue.id, name: SCREEN.name } },
      update: {},
      create: { venueId: venue.id, name: SCREEN.name },
    });

    // 150 seats: deterministic upserts on the (screen, row, number) unique key.
    const seatRows: Prisma.SeatCreateManyInput[] = [];
    for (const row of ROWS) {
      for (let number = 1; number <= SEATS_PER_ROW; number += 1) {
        seatRows.push({
          screenId: screen.id,
          rowLabel: row,
          seatNumber: number,
          category: PREMIUM_ROWS.has(row) ? 'PREMIUM' : 'REGULAR',
        });
      }
    }
    // skipDuplicates makes this a no-op for seats that already exist, which is
    // what makes re-running the seed safe.
    await prisma.seat.createMany({ data: seatRows, skipDuplicates: true });

    const showIds: string[] = [];
    for (const [index, show] of showSchedule().entries()) {
      const startTime = new Date(Date.now() + show.inHours * 60 * 60 * 1000);
      const record = await prisma.show.upsert({
        where: { id: `22222222-2222-4222-8222-22222222222${index}` },
        // start_time is intentionally NOT updated on re-seed: shifting show times
        // on every run would make seeded data unstable for tests and demos.
        update: { title: show.title, synopsis: show.synopsis },
        create: {
          id: `22222222-2222-4222-8222-22222222222${index}`,
          title: show.title,
          synopsis: show.synopsis,
          screenId: screen.id,
          startTime,
        },
      });
      showIds.push(record.id);

      for (const category of ['PREMIUM', 'REGULAR'] as const) {
        await prisma.showPrice.upsert({
          where: { showId_category: { showId: record.id, category } },
          update: { amountPaise: PRICES[category] },
          create: { showId: record.id, category, amountPaise: PRICES[category] },
        });
      }
    }

    const seatCount = await prisma.seat.count({ where: { screenId: screen.id } });
    return { venueId: venue.id, screenId: screen.id, showIds, seatCount };
  } finally {
    await prisma.$disconnect();
  }
}

// Only run when invoked directly (`pnpm db:seed`), not when imported by tests.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is not set. Copy apps/api/.env.example to apps/api/.env first.');
    process.exit(1);
  }
  seedDatabase(url)
    .then((result) => {
      console.log(
        `Seeded venue=${result.venueId} screen=${result.screenId} seats=${result.seatCount} shows=${result.showIds.length}`,
      );
    })
    .catch((error: unknown) => {
      console.error('Seed failed:', error);
      process.exit(1);
    });
}
