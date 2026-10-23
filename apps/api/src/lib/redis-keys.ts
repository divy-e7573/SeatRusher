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
