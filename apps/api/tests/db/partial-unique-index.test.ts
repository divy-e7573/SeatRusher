import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertInfrastructureReady,
  closeQuietly,
  TEST_FIXTURE_SHOW_PREFIX,
  testConfig,
  testPrisma,
} from '../helpers/test-app.js';

/**
 * The most important test in the repository: it proves the DATABASE ITSELF
 * refuses to let two active bookings hold the same seat, no matter what the
 * application does. Redis locks are a performance layer; this index is the
 * guarantee (AGENTS.md invariant 2, PRD 6.2).
 */
describe('partial unique index on booking_seats (show_id, seat_id)', () => {
  const config = testConfig();
  let prisma: PrismaClient;

  const SHOW_A = '44444444-4444-4444-8444-444444444441';
  const SHOW_B = '44444444-4444-4444-8444-444444444442';
  const USER_1 = '55555555-5555-4555-8555-555555555551';
  const USER_2 = '55555555-5555-4555-8555-555555555552';
  let seatId: string;

  beforeAll(async () => {
    await assertInfrastructureReady(config);
    prisma = testPrisma(config);

    const screen = await prisma.screen.findFirstOrThrow();
    seatId = (await prisma.seat.findFirstOrThrow({ where: { screenId: screen.id } })).id;

    // Two shows in the same screen share the same physical seats.
    await prisma.show.create({
      data: {
        id: SHOW_A,
        title: `${TEST_FIXTURE_SHOW_PREFIX}Constraint Show A`,
        screenId: screen.id,
        startTime: new Date('2026-01-01T10:00:00Z'),
      },
    });
    await prisma.show.create({
      data: {
        id: SHOW_B,
        title: `${TEST_FIXTURE_SHOW_PREFIX}Constraint Show B`,
        screenId: screen.id,
        startTime: new Date('2026-01-01T18:00:00Z'),
      },
    });
    await prisma.user.createMany({
      data: [
        { id: USER_1, email: 'constraint-1@test.local', passwordHash: 'x', displayName: 'One' },
        { id: USER_2, email: 'constraint-2@test.local', passwordHash: 'x', displayName: 'Two' },
      ],
    });
  });

  afterAll(async () => {
    await prisma?.show.deleteMany({ where: { id: { in: [SHOW_A, SHOW_B] } } });
    await prisma?.user.deleteMany({ where: { id: { in: [USER_1, USER_2] } } });
    await closeQuietly(prisma);
  });

  async function bookSeat(
    bookingId: string,
    userId: string,
    showId: string,
    status: 'PENDING' | 'CONFIRMED',
  ) {
    return prisma.booking.create({
      data: {
        id: bookingId,
        userId,
        showId,
        status,
        totalAmountPaise: 20000,
        expiresAt: new Date(Date.now() + 600_000),
        seats: { create: { showId, seatId, status, pricePaise: 20000 } },
      },
    });
  }

  it('rejects a second active booking for the same seat in the same show (P2002)', async () => {
    const first = await bookSeat('66666666-6666-4666-8666-666666666661', USER_1, SHOW_A, 'PENDING');

    await expect(
      bookSeat('66666666-6666-4666-8666-666666666662', USER_2, SHOW_A, 'CONFIRMED'),
    ).rejects.toMatchObject({
      code: 'P2002',
    });

    await prisma.booking.delete({ where: { id: first.id } });
  });

  it('allows the same seat again once the earlier booking is EXPIRED', async () => {
    const first = await bookSeat('66666666-6666-4666-8666-666666666663', USER_1, SHOW_A, 'PENDING');
    await prisma.booking.update({
      where: { id: first.id },
      data: {
        status: 'EXPIRED',
        seats: { updateMany: { where: {}, data: { status: 'EXPIRED' } } },
      },
    });

    // The partial index predicate no longer covers the EXPIRED row, so the seat
    // is free again - the exact behaviour a hold expiry needs in Phase 5.
    const second = await bookSeat(
      '66666666-6666-4666-8666-666666666664',
      USER_2,
      SHOW_A,
      'CONFIRMED',
    );
    expect(second.status).toBe('CONFIRMED');

    await prisma.booking.delete({ where: { id: second.id } });
    await prisma.booking.delete({ where: { id: first.id } });
  });

  it('allows two PENDING bookings for the same seat in DIFFERENT shows', async () => {
    // The index is (show_id, seat_id), not (seat_id): one seat can be sold for
    // the 10:00 show and the 18:00 show at the same time.
    const a = await bookSeat('66666666-6666-4666-8666-666666666665', USER_1, SHOW_A, 'CONFIRMED');
    const b = await bookSeat('66666666-6666-4666-8666-666666666666', USER_2, SHOW_B, 'CONFIRMED');
    expect(a.id).not.toBe(b.id);

    await prisma.booking.delete({ where: { id: a.id } });
    await prisma.booking.delete({ where: { id: b.id } });
  });

  it('surfaces P2002 as a typed Prisma error that the API maps to 409', async () => {
    const first = await bookSeat('66666666-6666-4666-8666-666666666667', USER_1, SHOW_A, 'PENDING');
    const testBookingIds = [
      '66666666-6666-4666-8666-666666666661',
      '66666666-6666-4666-8666-666666666662',
      '66666666-6666-4666-8666-666666666663',
      '66666666-6666-4666-8666-666666666664',
      '66666666-6666-4666-8666-666666666665',
      '66666666-6666-4666-8666-666666666666',
      '66666666-6666-4666-8666-666666666667',
      '66666666-6666-4666-8666-666666666668',
    ];
    try {
      await bookSeat('66666666-6666-4666-8666-666666666668', USER_2, SHOW_A, 'PENDING');
      throw new Error('expected the unique constraint to reject the second booking');
    } catch (error) {
      expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
    } finally {
      await prisma.booking.deleteMany({ where: { id: { in: testBookingIds } } });
      void first;
    }
  });
});
