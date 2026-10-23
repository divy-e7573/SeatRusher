import {
  SEAT_STATUS,
  type ShowDetail,
  type ShowSeats,
  type ShowSeat,
  type ShowSummary,
} from 'shared';
import { NotFoundError } from '../../lib/errors.js';
import type { ShowCache } from './shows-cache.js';
import type { SeatRecord, ShowRecord, ShowsRepository } from './shows-repository.js';

/**
 * Business rules for the read APIs.
 *
 * The service owns two things the repository cannot: turning missing rows into
 * proper 404 errors, and the cache-aside strategy (try Redis, fall back to
 * Postgres, then write back).
 */

export interface ShowsServiceDeps {
  repository: ShowsRepository;
  cache: ShowCache;
}

function toSummary(show: ShowRecord, totalSeats: number, availableSeats: number): ShowSummary {
  return {
    id: show.id,
    title: show.title,
    synopsis: show.synopsis,
    screenId: show.screenId,
    screenName: show.screenName,
    venueName: show.venueName,
    venueCity: show.venueCity,
    startTime: show.startTime.toISOString(),
    prices: show.prices,
    totalSeats,
    availableSeats,
  };
}

function seatWithPrice(seat: SeatRecord, show: ShowRecord) {
  return {
    id: seat.id,
    rowLabel: seat.rowLabel,
    seatNumber: seat.seatNumber,
    category: seat.category,
    pricePaise: show.prices.find((price) => price.category === seat.category)?.amountPaise ?? 0,
  };
}

export function createShowsService({ repository, cache }: ShowsServiceDeps) {
  /** Shared load path so the cached and uncached detail builds the same value. */
  async function loadShowDetail(showId: string): Promise<ShowDetail> {
    const show = await repository.findShowById(showId);
    if (!show) {
      throw new NotFoundError(`Show ${showId} not found`);
    }
    const totalSeats = await repository.countSeatsForScreen(show.screenId);
    const bookedSeats = await repository.countActiveBookedSeats(showId);
    return toSummary(show, totalSeats, Math.max(0, totalSeats - bookedSeats));
  }

  return {
    /** `GET /shows`: not cached in Phase 1; the list is small and always read-through. */
    async listShows(): Promise<ShowSummary[]> {
      const shows = await repository.listShows();
      return Promise.all(
        shows.map(async (show) => {
          const totalSeats = await repository.countSeatsForScreen(show.screenId);
          const bookedSeats = await repository.countActiveBookedSeats(show.id);
          return toSummary(show, totalSeats, Math.max(0, totalSeats - bookedSeats));
        }),
      );
    },

    async getShowDetail(showId: string): Promise<ShowDetail> {
      const cached = await cache.getShowDetail(showId);
      if (cached) {
        return cached;
      }
      const detail = await loadShowDetail(showId);
      await cache.setShowDetail(detail);
      return detail;
    },

    async getShowSeats(showId: string): Promise<ShowSeats> {
      const base = await repository.findSeatLayoutByShowId(showId);
      if (!base) {
        throw new NotFoundError(`Show ${showId} not found`);
      }

      // Static geometry comes from the cache (no TTL); live status always comes
      // from Postgres, so a booked seat can never be served as available because
      // of a stale cache entry.
      let layout = await cache.getSeatLayout(showId);
      if (!layout || layout.screenId !== base.show.screenId) {
        layout = {
          screenId: base.show.screenId,
          seats: base.seats.map((seat) => seatWithPrice(seat, base.show)),
        };
        await cache.setSeatLayout(showId, layout);
      }

      const booked = new Set(
        (await repository.findActiveBookedSeatIds(showId)).map((row) => row.seatId),
      );
      const seats: ShowSeat[] = layout.seats.map((seat) => ({
        ...seat,
        status: booked.has(seat.id) ? SEAT_STATUS.BOOKED : SEAT_STATUS.AVAILABLE,
      }));

      return {
        showId,
        screenId: base.show.screenId,
        screenName: base.show.screenName,
        venueName: base.show.venueName,
        totalSeats: seats.length,
        availableSeats: seats.length - booked.size,
        seats,
      };
    },
  };
}

/** Inferred service shape, exported so routes and tests can name it. */
export type ShowsService = ReturnType<typeof createShowsService>;
