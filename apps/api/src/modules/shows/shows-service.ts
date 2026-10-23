import {
  SEAT_STATUS,
  type ShowDetail,
  type ShowSeats,
  type ShowSeat,
  type ShowSummary,
} from 'shared';
import { NotFoundError, ServiceUnavailableError } from '../../lib/errors.js';
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
  /**
   * Live hold status from Redis, injected as a port so the shows module never
   * imports the holds module (and therefore never learns how holds are locked).
   */
  holds: SeatHoldStatusReader;
}

/**
 * The slice of the hold store that the read API needs: which of these seats
 * are currently held. Deliberately returns ids only, so the public seat map
 * can never reveal who is holding a seat.
 */
export interface SeatHoldStatusReader {
  findHeldSeatIds(showId: string, seatIds: string[]): Promise<Set<string>>;
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

export function createShowsService({ repository, cache, holds }: ShowsServiceDeps) {
  /**
   * Cache-aside resilience: a cache outage degrades to a Postgres read instead
   * of failing the request. The cache is an optimisation, so it must never be
   * the reason a read API fails - and it is deliberately NOT treated like a
   * failed hold-status read, which must surface as a 503 so that nobody
   * mistakes unknown status for a free seat.
   */
  async function cacheOrFallback<T>(
    operation: () => Promise<T>,
    fallback: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ServiceUnavailableError) {
        return fallback();
      }
      throw error;
    }
  }

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
      const cached = await cacheOrFallback(
        () => cache.getShowDetail(showId),
        async () => null,
      );
      if (cached) {
        return cached;
      }
      const detail = await loadShowDetail(showId);
      await cacheOrFallback(
        () => cache.setShowDetail(detail),
        async () => undefined,
      );
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
      let layout = await cacheOrFallback(
        () => cache.getSeatLayout(showId),
        async () => null,
      );
      if (!layout || layout.screenId !== base.show.screenId) {
        const freshLayout = {
          screenId: base.show.screenId,
          seats: base.seats.map((seat) => seatWithPrice(seat, base.show)),
        };
        await cacheOrFallback(
          () => cache.setSeatLayout(showId, freshLayout),
          async () => undefined,
        );
        layout = freshLayout;
      }

      const booked = new Set(
        (await repository.findActiveBookedSeatIds(showId)).map((row) => row.seatId),
      );

      // Live status is never cached: a seat map cached with HELD/BOOKED would
      // keep showing a stale claim long after the hold expired. Only the static
      // geometry above is cacheable.
      let held: Set<string>;
      try {
        held = await holds.findHeldSeatIds(
          showId,
          layout.seats.map((seat) => seat.id),
        );
      } catch (error) {
        if (error instanceof ServiceUnavailableError) {
          // Fail loudly rather than fall back to "nothing is held": a seat map
          // that reports a held seat as available invites a doomed checkout.
          throw new ServiceUnavailableError(
            'Live seat status is temporarily unavailable. Please try again shortly.',
          );
        }
        throw error;
      }

      // Precedence is BOOKED > HELD > AVAILABLE. A seat that is somehow both
      // booked and held reports BOOKED, because Postgres is the source of truth.
      const seats: ShowSeat[] = layout.seats.map((seat) => ({
        ...seat,
        status: booked.has(seat.id)
          ? SEAT_STATUS.BOOKED
          : held.has(seat.id)
            ? SEAT_STATUS.HELD
            : SEAT_STATUS.AVAILABLE,
      }));

      const availableCount = seats.filter((seat) => seat.status === SEAT_STATUS.AVAILABLE).length;

      return {
        showId,
        screenId: base.show.screenId,
        screenName: base.show.screenName,
        venueName: base.show.venueName,
        totalSeats: seats.length,
        availableSeats: availableCount,
        seats,
      };
    },
  };
}

/** Inferred service shape, exported so routes and tests can name it. */
export type ShowsService = ReturnType<typeof createShowsService>;
