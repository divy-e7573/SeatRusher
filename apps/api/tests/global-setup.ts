import { PrismaClient } from '@prisma/client';
import { resolveTestDatabaseUrl } from '../prisma/test-database.js';
import { TEST_FIXTURE_SHOW_PREFIX } from './helpers/test-app.js';

/**
 * Removes shows left behind by an INTERRUPTED test run.
 *
 * Suites that need extra rows create their own show, tagged with
 * `TEST_FIXTURE_SHOW_PREFIX`, and delete it in `afterAll`. If a run is killed
 * (Ctrl-C, a crashed container, a failed assertion mid-suite) that cleanup is
 * skipped, and the leftovers then show up in tests that count rows - which is
 * exactly the kind of failure that looks like a product bug and is not.
 *
 * This runs once, before any test file starts, so it cannot delete a fixture
 * another suite is actively using. A cleanup failure is deliberately ignored:
 * it must never be the reason a test run cannot start.
 */
export async function setup(): Promise<void> {
  const prisma = new PrismaClient({
    datasources: { db: { url: resolveTestDatabaseUrl(process.env) } },
  });

  try {
    const leftovers = await prisma.show.findMany({
      where: { title: { startsWith: TEST_FIXTURE_SHOW_PREFIX } },
      select: { id: true },
    });
    const showIds = leftovers.map((show) => show.id);
    if (showIds.length === 0) {
      return;
    }

    // Bookings restrict deletion, so unwind the children first.
    await prisma.bookingSeat.deleteMany({ where: { showId: { in: showIds } } });
    await prisma.booking.deleteMany({ where: { showId: { in: showIds } } });
    await prisma.show.deleteMany({ where: { id: { in: showIds } } });
  } catch {
    // Best effort only; see the doc comment.
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}
