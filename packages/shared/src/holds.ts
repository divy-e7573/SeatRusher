import { z } from 'zod';

/**
 * Seat-hold contracts shared by the API and the web app.
 *
 * FR-3: a user may hold at most 6 seats per show, and a multi-seat hold is
 * all-or-nothing. Both rules are enforced in the Lua script, not here, because
 * they must hold across concurrent requests, not merely per request.
 */

/** The PRD's hard cap on seats one user may hold at once for a single show. */
export const MAX_SEATS_PER_HOLD = 6;

/** FR-3: a hold lives for 10 minutes, enforced by the Redis TTL. */
export const HOLD_TTL_SECONDS = 600;

/**
 * Body of POST /shows/:id/holds.
 *
 * The refine() rejects a list containing the same seat twice. Redis would treat
 * the second occurrence as an occupied seat (the first SET has already run), so
 * allowing duplicates would turn a typo into a self-inflicted 409.
 */
export const createHoldRequestSchema = z.object({
  seatIds: z
    .array(z.string().uuid('must be a valid UUID'))
    .min(1, 'must hold at least one seat')
    .max(MAX_SEATS_PER_HOLD, 'must hold at most 6 seats')
    .refine((seatIds) => new Set(seatIds).size === seatIds.length, 'must not repeat a seat'),
});

export type CreateHoldRequest = z.infer<typeof createHoldRequestSchema>;

/**
 * Response of POST /shows/:id/holds and DELETE /holds/:holdId.
 *
 * Deliberately says nothing about WHO holds a seat beyond the caller's own hold:
 * every hold endpoint is authenticated, and no field exposes another user's id.
 */
export interface Hold {
  holdId: string;
  showId: string;
  seatIds: string[];
  /** Server-generated UTC expiry (invariant 7: never a client clock). */
  expiresAt: string;
  /** Seconds remaining, so the client can count down without guessing. */
  ttlSeconds: number;
}

export const ERROR_CODE_HOLD = {
  /** A requested seat is already held by someone else, or already booked. */
  SEAT_CONFLICT: 'SEAT_CONFLICT',
  /** Holding more than 6 seats for one show across all active holds. */
  HOLD_LIMIT_EXCEEDED: 'HOLD_LIMIT_EXCEEDED',
  /** Redis is unavailable. Holds fail closed rather than being silently skipped. */
  HOLDS_UNAVAILABLE: 'HOLDS_UNAVAILABLE',
  /** The hold does not exist, has expired, or belongs to someone else. */
  HOLD_NOT_FOUND: 'HOLD_NOT_FOUND',
} as const;
