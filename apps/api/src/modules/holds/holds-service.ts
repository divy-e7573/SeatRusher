import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { ERROR_CODE_HOLD, MAX_SEATS_PER_HOLD, type Hold } from 'shared';
import { AppError } from '../../lib/errors.js';
import type { HoldPreconditionsRepository } from './hold-preconditions-repository.js';
import { HoldStoreUnavailableError, type HoldsRepository } from './holds-repository.js';

/**
 * Business rules for seat holds.
 *
 * The route layer never decides anything: it parses input, derives the user id
 * from the verified token, and delegates here.
 */

export interface HoldsServiceDeps {
  holds: HoldsRepository;
  preconditions: HoldPreconditionsRepository;
  ttlSeconds: number;
  maxSeats: number;
  logger: FastifyBaseLogger;
  /** Server clock (invariant 7: never a client clock). */
  now?: () => Date;
}

export function createHoldsService({
  holds,
  preconditions,
  ttlSeconds,
  maxSeats,
  logger,
  now = () => new Date(),
}: HoldsServiceDeps) {
  /** Translates a dead Redis into the fail-closed 503 of invariant 9. */
  function toServiceUnavailable(error: unknown): AppError {
    if (error instanceof HoldStoreUnavailableError) {
      logger.error({ err: error }, 'seat hold rejected: Redis unavailable');
      return new AppError(
        'Seat holds are temporarily unavailable. Please try again shortly.',
        ERROR_CODE_HOLD.HOLDS_UNAVAILABLE,
        503,
      );
    }
    throw error;
  }

  return {
    async createHold(input: { showId: string; seatIds: string[]; userId: string }): Promise<Hold> {
      const { showId, seatIds, userId } = input;

      if (seatIds.length > maxSeats) {
        // Normally unreachable: the zod schema caps this first. Kept so the
        // business rule holds even if a caller skips the schema.
        throw new AppError(
          `You can hold at most ${maxSeats} seats for a show at once`,
          ERROR_CODE_HOLD.HOLD_LIMIT_EXCEEDED,
          409,
        );
      }

      const screenId = await preconditions.findShowScreenId(showId);
      if (!screenId) {
        throw new AppError(`Show ${showId} not found`, 'NOT_FOUND', 404);
      }

      const existing = await preconditions.findExistingSeatIds(screenId, seatIds);
      if (existing.size !== seatIds.length) {
        // Either the id is not a seat at all, or it belongs to another screen.
        // Both are client mistakes, so neither is reported as a conflict.
        throw new AppError('One or more seats do not belong to this show', 'BAD_REQUEST', 400);
      }

      const booked = await preconditions.findBookedSeatIds(showId, seatIds);
      if (booked.size > 0) {
        throw new AppError(
          'One or more of those seats is already booked',
          ERROR_CODE_HOLD.SEAT_CONFLICT,
          409,
        );
      }

      const startedAt = now();
      const expiresAt = new Date(startedAt.getTime() + ttlSeconds * 1000);
      const holdId = randomUUID();

      let result;
      try {
        result = await holds.acquire(
          { holdId, showId, userId, seatIds, expiresAt, now: startedAt },
          ttlSeconds,
          maxSeats,
        );
      } catch (error) {
        throw toServiceUnavailable(error);
      }

      if (!result.ok && result.reason === 'SEAT_CONFLICT') {
        logger.info(
          { userId, showId, conflictingSeatId: result.conflictingSeatId },
          'hold rejected: seat already held',
        );
        throw new AppError(
          'One or more of those seats is already held by another user',
          ERROR_CODE_HOLD.SEAT_CONFLICT,
          409,
        );
      }

      if (!result.ok && result.reason === 'HOLD_LIMIT_EXCEEDED') {
        logger.info(
          { userId, showId, heldSeats: result.currentlyHeldSeats },
          'hold rejected: seat limit reached',
        );
        throw new AppError(
          `You already hold ${result.currentlyHeldSeats} seat(s) for this show; the limit is ${maxSeats}`,
          ERROR_CODE_HOLD.HOLD_LIMIT_EXCEEDED,
          409,
        );
      }

      logger.info(
        { userId, showId, holdId, seatCount: seatIds.length, expiresAt: expiresAt.toISOString() },
        'seat hold created',
      );

      return {
        holdId,
        showId,
        seatIds,
        expiresAt: expiresAt.toISOString(),
        ttlSeconds,
      };
    },

    async releaseHold(holdId: string, userId: string): Promise<void> {
      let result;
      try {
        result = await holds.release(holdId, userId);
      } catch (error) {
        throw toServiceUnavailable(error);
      }

      if (!result.ok) {
        // Expired, already released, or owned by somebody else. The three are
        // deliberately indistinguishable so the endpoint cannot confirm that
        // somebody else's hold exists.
        logger.info({ userId, holdId }, 'hold release: not found, expired, or not owned');
        throw new AppError(
          'Hold not found. It may have expired, been released, or belong to another user',
          ERROR_CODE_HOLD.HOLD_NOT_FOUND,
          404,
        );
      }

      logger.info({ userId, holdId, releasedSeats: result.releasedSeats }, 'seat hold released');
    },
  };
}

export type HoldsService = ReturnType<typeof createHoldsService>;

/** Re-exported so the routes layer documents the cap it enforces via zod. */
export { MAX_SEATS_PER_HOLD };
