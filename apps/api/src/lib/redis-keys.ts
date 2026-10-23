/**
 * Every Redis key the API uses, defined in exactly one place.
 *
 * AGENTS.md requires this, because a typo in a key string is the kind of bug that
 * silently disables a cache or, worse, lets one feature read another feature's data.
 */

/** Static seat layout of a show (no TTL - the physical layout never changes). */
export function seatLayoutKey(showId: string): string {
  return `seat:layout:${showId}`;
}

/** Show detail including the (slowly drifting) available-seat count. */
export function showDetailKey(showId: string): string {
  return `show:detail:${showId}`;
}

/** Pattern matching every cached show detail key; used by targeted invalidation. */
export function showDetailKeyPattern(showId: string): string {
  return showDetailKey(showId);
}

/** Pattern matching every cached layout key; used by the seed's cache reset. */
export function seatLayoutKeyPattern(): string {
  return 'seat:layout:*';
}

/** TTL for show detail: short enough that availability drift self-heals. */
export const SHOW_DETAIL_TTL_SECONDS = 300;

// --- Seat holds (Phase 3) -------------------------------------------------
// The three key names below are fixed by AGENTS.md, so every contributor (and
// every future socket worker) derives them from here rather than concatenating
// strings inline.

/**
 * One seat lock: hold:{showId}:{seatId}.
 *
 * Value is {userId}:{holdId}. The user id prefix makes an owner-only release a
 * compare-and-delete; the hold id says which of that user's own holds owns it.
 */
export function seatHoldKey(showId: string, seatId: string): string {
  return `hold:${showId}:${seatId}`;
}

/** Metadata of one hold: hold_meta:{holdId}. Holds the seat list and expiry. */
export function holdMetaKey(holdId: string): string {
  return `hold_meta:${holdId}`;
}

/**
 * Every live hold of one user for one show: user_holds:{userId}:{showId}.
 *
 * A ZSET, not a set: the score is the expiry timestamp in epoch milliseconds,
 * so one ZREMRANGEBYSCORE deletes every expired entry. That is what stops
 * abandoned metadata from permanently consuming a user's 6-seat allowance
 * (a plain SET has no per-member TTL and would leak).
 */
export function userHoldsKey(userId: string, showId: string): string {
  return `user_holds:${userId}:${showId}`;
}

/** Member format of the ZSET: holdId and seat count joined by a colon. */
export function userHoldMember(holdId: string, seatCount: number): string {
  return `${holdId}:${seatCount}`;
}

/** Matches every seat lock of one show; used by tests and the Phase 5 sweeper. */
export function seatHoldKeyPattern(showId: string): string {
  return `hold:${showId}:*`;
}
