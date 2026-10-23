import type { PrismaClient } from '@prisma/client';
import { ACTIVE_BOOKING_STATUSES } from 'shared';

/**
 * The Postgres half of a hold: everything that must be true BEFORE Redis is
 * asked to lock a seat.
 *
 * Postgres stays the final source of truth (invariant 1). A Redis hold is a
 * fast, temporary reservation, so a seat that is already BOOKED must never
 * even reach Redis - otherwise we would hand out a hold on a sold seat and
 * discover the problem only at checkout.
 */

export interface HoldPreconditionsRepository {
  /** Screen of the show, or null when the show does not exist. */
  findShowScreenId(showId: string): Promise<string | null>;
  /** Which of the requested seat ids actually exist in this show's screen. */
  findExistingSeatIds(screenId: string, seatIds: string[]): Promise<Set<string>>;
  /** Which of the requested seats are occupied by an active booking. */
  findBookedSeatIds(showId: string, seatIds: string[]): Promise<Set<string>>;
}

export function createHoldPreconditionsRepository(
  prisma: PrismaClient,
): HoldPreconditionsRepository {
  return {
    async findShowScreenId(showId) {
      const show = await prisma.show.findUnique({
        where: { id: showId },
        select: { screenId: true },
      });
      return show?.screenId ?? null;
    },

    async findExistingSeatIds(screenId, seatIds) {
      const seats = await prisma.seat.findMany({
        where: { id: { in: seatIds }, screenId },
        select: { id: true },
      });
      return new Set(seats.map((seat) => seat.id));
    },

    async findBookedSeatIds(showId, seatIds) {
      const rows = await prisma.bookingSeat.findMany({
        where: {
          showId,
          seatId: { in: seatIds },
          status: { in: [...ACTIVE_BOOKING_STATUSES] },
        },
        select: { seatId: true },
      });
      return new Set(rows.map((row) => row.seatId));
    },
  };
}
