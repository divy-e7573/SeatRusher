import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { holdMetaKey, seatHoldKey, userHoldsKey } from '../../lib/redis-keys.js';
import { ensureRedisConnected } from '../../lib/redis.js';
import { ServiceUnavailableError } from '../../lib/errors.js';
import { ACQUIRE_HOLD_SCRIPT, RELEASE_HOLD_SCRIPT } from './holds-scripts.js';

/**
 * Redis access for seat holds. Every state-changing path goes through a Lua
 * script; the only read path is an MGET used to colour the seat map.
 */

/**
 * Redis could not serve a hold request. Extends the shared 503 error so the
 * service layer maps it with `instanceof` rather than a string check.
 */
export class HoldStoreUnavailableError extends ServiceUnavailableError {
  constructor(message: string) {
    super(message);
    this.name = 'HoldStoreUnavailableError';
  }
}

export type AcquireHoldResult =
  | { ok: true; holdId: string; heldSeatsForUser: number }
  | { ok: false; reason: 'SEAT_CONFLICT'; conflictingSeatId: string | null }
  | { ok: false; reason: 'HOLD_LIMIT_EXCEEDED'; currentlyHeldSeats: number };

export type ReleaseHoldResult =
  { ok: true; releasedSeats: number } | { ok: false; reason: 'HOLD_NOT_FOUND' };

export interface AcquireHoldInput {
  holdId: string;
  showId: string;
  userId: string;
  seatIds: string[];
  expiresAt: Date;
  now: Date;
}

export interface HoldsRepository {
  acquire(
    input: AcquireHoldInput,
    ttlSeconds: number,
    maxSeats: number,
  ): Promise<AcquireHoldResult>;
  release(holdId: string, userId: string): Promise<ReleaseHoldResult>;
  /**
   * Which of these seats currently carry a live hold.
   *
   * Returns ids only, never the stored value, so no caller can leak who is
   * holding a seat. Throws HoldStoreUnavailableError when Redis is down, which
   * the seat-map endpoint turns into a 503 instead of reporting a full house.
   */
  findHeldSeatIds(showId: string, seatIds: string[]): Promise<Set<string>>;
}

const ACQUIRE_SHA = sha1(ACQUIRE_HOLD_SCRIPT);
const RELEASE_SHA = sha1(RELEASE_HOLD_SCRIPT);

function sha1(script: string): string {
  return createHash('sha1').update(script).digest('hex');
}

/** ioredis signals a cold script cache with this message. */
function isNoScriptError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('NOSCRIPT');
}

/**
 * Runs a script via EVALSHA and transparently falls back to EVAL when Redis
 * has forgotten the script (restart, SCRIPT FLUSH). The fallback also warms
 * the cache again, so only the first call after a flush pays the full body.
 */
async function runScript(
  redis: Redis,
  script: string,
  sha: string,
  keys: string[],
  args: string[],
): Promise<unknown> {
  await ensureRedisConnected(redis);
  try {
    return await redis.evalsha(sha, keys.length, ...keys, ...args);
  } catch (error) {
    if (isNoScriptError(error)) {
      return redis.eval(script, keys.length, ...keys, ...args);
    }
    throw error;
  }
}

/** Redis replies with a flat array of bulk strings for a Lua table return. */
function toReplyList(reply: unknown): string[] {
  if (!Array.isArray(reply)) {
    return [];
  }
  return reply.map((part) => (part === null ? '' : String(part)));
}

function toInteger(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeMessage(error: unknown): string {
  // Keeps connection strings (which embed passwords) out of error messages.
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/redis(?:s)?:\/\/[^\s"'<>]+/gi, 'redis://[redacted]');
}

export function createHoldsRepository(redis: Redis): HoldsRepository {
  return {
    async acquire(input, ttlSeconds, maxSeats): Promise<AcquireHoldResult> {
      const { holdId, showId, userId, seatIds, expiresAt, now } = input;
      const keys = [
        userHoldsKey(userId, showId),
        holdMetaKey(holdId),
        ...seatIds.map((seatId) => seatHoldKey(showId, seatId)),
      ];
      const args = [
        String(now.getTime()),
        String(ttlSeconds),
        String(maxSeats),
        String(seatIds.length),
        userId,
        holdId,
        showId,
        expiresAt.toISOString(),
        JSON.stringify(seatIds),
      ];

      let reply: unknown;
      try {
        reply = await runScript(redis, ACQUIRE_HOLD_SCRIPT, ACQUIRE_SHA, keys, args);
      } catch (error) {
        throw new HoldStoreUnavailableError(
          'Could not reach Redis to place the hold: ' + safeMessage(error),
        );
      }

      const parts = toReplyList(reply);
      const status = parts[0] ?? '';

      if (status === 'OK') {
        return { ok: true, holdId: parts[1] ?? holdId, heldSeatsForUser: toInteger(parts[2]) };
      }

      if (status === 'HOLD_LIMIT_EXCEEDED') {
        return {
          ok: false,
          reason: 'HOLD_LIMIT_EXCEEDED',
          currentlyHeldSeats: toInteger(parts[1]),
        };
      }

      if (status === 'SEAT_CONFLICT') {
        // The script returns the conflicting KEY name; we strip the prefix back
        // to a bare seat id so the message never echoes internal key structure.
        const rawKey = parts[1] ?? '';
        const seatId = rawKey.startsWith('hold:')
          ? rawKey.slice(rawKey.lastIndexOf(':') + 1)
          : null;
        return { ok: false, reason: 'SEAT_CONFLICT', conflictingSeatId: seatId };
      }

      throw new HoldStoreUnavailableError(
        'Redis returned an unexpected reply while placing the hold',
      );
    },

    async release(holdId, userId): Promise<ReleaseHoldResult> {
      let reply: unknown;
      try {
        reply = await runScript(
          redis,
          RELEASE_HOLD_SCRIPT,
          RELEASE_SHA,
          [holdMetaKey(holdId)],
          [userId],
        );
      } catch (error) {
        throw new HoldStoreUnavailableError(
          'Could not reach Redis to release the hold: ' + safeMessage(error),
        );
      }

      const parts = toReplyList(reply);
      if (parts[0] === 'OK') {
        return { ok: true, releasedSeats: toInteger(parts[1]) };
      }
      return { ok: false, reason: 'HOLD_NOT_FOUND' };
    },

    async findHeldSeatIds(showId, seatIds): Promise<Set<string>> {
      if (seatIds.length === 0) {
        return new Set();
      }

      let values: (string | null)[];
      try {
        await ensureRedisConnected(redis);
        // Naming the keys needs the seat layout, which is exactly what the
        // static layout cache provides: this stays a single round trip.
        values = await redis.mget(...seatIds.map((seatId) => seatHoldKey(showId, seatId)));
      } catch (error) {
        throw new HoldStoreUnavailableError(
          'Could not reach Redis to read live seat status: ' + safeMessage(error),
        );
      }

      const held = new Set<string>();
      seatIds.forEach((seatId, index) => {
        if (values[index] !== null) {
          held.add(seatId);
        }
      });
      return held;
    },
  };
}
