import type { Prisma, PrismaClient } from '@prisma/client';
import { ACTIVE_BOOKING_STATUSES, type SeatCategory as SharedSeatCategory } from 'shared';

/**
 * Data access for shows. This is the ONLY module that knows Prisma exists;
 * services receive plain records, which keeps the ORM out of business logic and
 * makes the service trivially testable.
 */

export interface ShowPriceRecord {
  category: SharedSeatCategory;
  amountPaise: number;
}

export interface ShowRecord {
  id: string;
  title: string;
  synopsis: string | null;
  screenId: string;
  screenName: string;
  venueName: string;
  venueCity: string;
  startTime: Date;
  prices: ShowPriceRecord[];
}

export interface SeatRecord {
  id: string;
  rowLabel: string;
  seatNumber: number;
  category: SharedSeatCategory;
}

export interface BookedSeatRecord {
  seatId: string;
}

export interface ShowsRepository {
  /** All shows ordered by start time, with their static prices. */
  listShows(): Promise<ShowRecord[]>;
  /** A single show, or null when the id does not exist. */
  findShowById(showId: string): Promise<ShowRecord | null>;
  /** Physical seats of a show's screen (ordered row, then number), or null if the show is unknown. */
  findSeatLayoutByShowId(showId: string): Promise<{ show: ShowRecord; seats: SeatRecord[] } | null>;
  /** Seat ids currently occupied by an active (PENDING/CONFIRMED) booking. */
  findActiveBookedSeatIds(showId: string): Promise<BookedSeatRecord[]>;
  /** Number of seats occupied by active bookings, used for available-seat counts. */
  countActiveBookedSeats(showId: string): Promise<number>;
  /** Number of physical seats in a screen (the denominator of availability). */
  countSeatsForScreen(screenId: string): Promise<number>;
}

export function createShowsRepository(prisma: PrismaClient): ShowsRepository {
  const showInclude = {
    screen: { include: { venue: true } },
    prices: { orderBy: { category: 'asc' } },
  } as const;

  type ShowWithRelations = Prisma.ShowGetPayload<{ include: typeof showInclude }>;

  function toRecord(show: ShowWithRelations): ShowRecord {
    return {
      id: show.id,
      title: show.title,
      synopsis: show.synopsis,
      screenId: show.screenId,
      screenName: show.screen.name,
      venueName: show.screen.venue.name,
      venueCity: show.screen.venue.city,
      startTime: show.startTime,
      prices: show.prices.map((price) => ({
        category: price.category as SharedSeatCategory,
        amountPaise: price.amountPaise,
      })),
    };
  }

  return {
    async listShows(): Promise<ShowRecord[]> {
      const shows = await prisma.show.findMany({
        include: showInclude,
        orderBy: { startTime: 'asc' },
      });
      return shows.map(toRecord);
    },

    async findShowById(showId: string): Promise<ShowRecord | null> {
      const show = await prisma.show.findUnique({ where: { id: showId }, include: showInclude });
      return show ? toRecord(show) : null;
    },

    async findSeatLayoutByShowId(showId: string) {
      const show = await prisma.show.findUnique({ where: { id: showId }, include: showInclude });
      if (!show) {
        return null;
      }
      const seats = await prisma.seat.findMany({
        where: { screenId: show.screenId },
        orderBy: [{ rowLabel: 'asc' }, { seatNumber: 'asc' }],
        select: { id: true, rowLabel: true, seatNumber: true, category: true },
      });
      return {
        show: toRecord(show),
        seats: seats.map((seat) => ({
          id: seat.id,
          rowLabel: seat.rowLabel,
          seatNumber: seat.seatNumber,
          category: seat.category as SharedSeatCategory,
        })),
      };
    },

    async findActiveBookedSeatIds(showId: string): Promise<BookedSeatRecord[]> {
      const rows = await prisma.bookingSeat.findMany({
        where: { showId, status: { in: [...ACTIVE_BOOKING_STATUSES] } },
        select: { seatId: true },
      });
      return rows;
    },

    async countActiveBookedSeats(showId: string): Promise<number> {
      return prisma.bookingSeat.count({
        where: { showId, status: { in: [...ACTIVE_BOOKING_STATUSES] } },
      });
    },

    async countSeatsForScreen(screenId: string): Promise<number> {
      return prisma.seat.count({ where: { screenId } });
    },
  };
}
