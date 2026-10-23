import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { z } from 'zod';
import { seatLayoutKey, showDetailKey, SHOW_DETAIL_TTL_SECONDS } from '../../lib/redis-keys.js';
import { ensureRedisConnected } from '../../lib/redis.js';
import type { ShowDetail } from 'shared';

/**
 * Redis cache for the read APIs.
 *
 * Two very different caching decisions live here (ADR 0002 explains why):
 *
 * - `seat:layout:{showId}` has NO TTL. A screen's physical layout is immutable,
 *   so an entry can never become stale; it is only removed by explicit
 *   invalidation (seed / admin layout change).
 * - `show:detail:{showId}` has a 5 minute TTL. It embeds the available-seat
 *   count, which drifts as bookings are made, so a short TTL lets the value
 *   self-heal instead of relying on every write path to remember to invalidate it.
 */

const seatSchema = z.object({
  id: z.string(),
  rowLabel: z.string(),
  seatNumber: z.number(),
  category: z.enum(['REGULAR', 'PREMIUM', 'RECLINER']),
  pricePaise: z.number(),
});

/** The static, cacheable part of a seat map: geometry plus prices, never status. */
const seatLayoutCacheSchema = z.object({
  screenId: z.string(),
  seats: z.array(seatSchema),
});

export type CachedSeatLayout = z.infer<typeof seatLayoutCacheSchema>;

const showDetailCacheSchema = z.object({
  id: z.string(),
  title: z.string(),
  synopsis: z.string().nullable(),
  screenId: z.string(),
  screenName: z.string(),
  venueName: z.string(),
  venueCity: z.string(),
  startTime: z.string(),
  prices: z.array(
    z.object({ category: z.enum(['REGULAR', 'PREMIUM', 'RECLINER']), amountPaise: z.number() }),
  ),
  totalSeats: z.number(),
  availableSeats: z.number(),
});

export interface ShowCache {
  getShowDetail(showId: string): Promise<ShowDetail | null>;
  setShowDetail(detail: ShowDetail): Promise<void>;
  getSeatLayout(showId: string): Promise<CachedSeatLayout | null>;
  setSeatLayout(showId: string, layout: CachedSeatLayout): Promise<void>;
  /** Drops every cached artefact for one show. Call after any write to that show. */
  invalidateShow(showId: string): Promise<void>;
  /** Removes every cached show detail and layout (used after re-seeding). */
  clearAllShowCaches(): Promise<number>;
}

export function createShowCache(redis: Redis, logger: Logger): ShowCache {
  async function readJson(key: string): Promise<string | null> {
    await ensureRedisConnected(redis);
    return redis.get(key);
  }

  return {
    async getShowDetail(showId: string): Promise<ShowDetail | null> {
      const raw = await readJson(showDetailKey(showId));
      if (raw === null) {
        return null;
      }
      const parsed = showDetailCacheSchema.safeParse(JSON.parse(raw) as unknown);
      if (!parsed.success) {
        // A corrupted or outdated cache entry must never break a request; treat it
        // as a miss and overwrite it on the next write.
        logger.warn({ showId }, 'discarding invalid show detail cache entry');
        return null;
      }
      return parsed.data;
    },

    async setShowDetail(detail: ShowDetail): Promise<void> {
      await ensureRedisConnected(redis);
      await redis.set(
        showDetailKey(detail.id),
        JSON.stringify(detail),
        'EX',
        SHOW_DETAIL_TTL_SECONDS,
      );
    },

    async getSeatLayout(showId: string): Promise<CachedSeatLayout | null> {
      const raw = await readJson(seatLayoutKey(showId));
      if (raw === null) {
        return null;
      }
      const parsed = seatLayoutCacheSchema.safeParse(JSON.parse(raw) as unknown);
      if (!parsed.success) {
        logger.warn({ showId }, 'discarding invalid seat layout cache entry');
        return null;
      }
      return parsed.data;
    },

    async setSeatLayout(showId: string, layout: CachedSeatLayout): Promise<void> {
      await ensureRedisConnected(redis);
      // No EX argument on purpose: the layout is immutable, so it never expires.
      await redis.set(seatLayoutKey(showId), JSON.stringify(layout));
    },

    async invalidateShow(showId: string): Promise<void> {
      await ensureRedisConnected(redis);
      await redis.del(showDetailKey(showId), seatLayoutKey(showId));
    },

    async clearAllShowCaches(): Promise<number> {
      await ensureRedisConnected(redis);
      // SCAN rather than KEYS: KEYS blocks the Redis event loop for the whole
      // keyspace, which would be self-defeating in the system's most latency
      // sensitive datastore.
      let cursor = '0';
      let removed = 0;
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', 'show:detail:*', 'COUNT', 100);
        cursor = next;
        if (keys.length > 0) {
          removed += await redis.del(...keys);
        }
      } while (cursor !== '0');

      cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', 'seat:layout:*', 'COUNT', 100);
        cursor = next;
        if (keys.length > 0) {
          removed += await redis.del(...keys);
        }
      } while (cursor !== '0');

      return removed;
    },
  };
}
