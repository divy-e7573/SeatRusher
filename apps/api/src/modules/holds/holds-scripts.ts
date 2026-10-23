/**
 * The two Lua scripts that make seat holds safe under concurrency.
 *
 * AGENTS.md invariant 3 forbids check-then-act for locks, and invariant 4
 * requires multi-seat holds to be all-or-nothing. Both rules exist here and
 * nowhere else: a Lua script runs to completion on a single Redis thread, so
 * no other command can interleave between the check and the write.
 *
 * Each script is loaded with EVALSHA; NOSCRIPT (the cache was flushed, or Redis
 * restarted) falls back to a one-off EVAL that repopulates the cache.
 */

/**
 * ACQUIRE - claims 1..6 seats for one user on one show, or nothing at all.
 *
 * Order matters:
 *   1. drop expired ZSET members          (stale metadata must not count)
 *   2. sum seats held by live holds       (the 6-seat cap)
 *   3. verify EVERY seat key is free      (all-or-nothing pre-check)
 *   4. write the seat keys, meta and ZSET (no failure path after this point)
 *
 * Step 3 is a pre-check, not the lock itself: it lets us abort with a precise
 * "which seat is taken" answer. Step 4 is still correct on its own, because
 * nothing can run between step 3 and step 4 - that is the entire point of Lua.
 */
export const ACQUIRE_HOLD_SCRIPT = `
local user_holds_key = KEYS[1]
local meta_key       = KEYS[2]
local seat_count     = tonumber(ARGV[4])

local now_ms        = tonumber(ARGV[1])
local ttl           = tonumber(ARGV[2])
local max_seats     = tonumber(ARGV[3])
local user_id       = ARGV[5]
local hold_id       = ARGV[6]
local show_id       = ARGV[7]
local expires_at    = ARGV[8]
local seat_ids_json = ARGV[9]

-- 1. Expired holds must stop counting towards the limit immediately, even if
--    nobody has touched this user's key since they lapsed.
redis.call('ZREMRANGEBYSCORE', user_holds_key, '-inf', now_ms)

-- 2. Count the seats this user already holds for this show.
local held = 0
local members = redis.call('ZRANGE', user_holds_key, 0, -1)
for i = 1, #members do
  local count = string.match(members[i], ':(%d+)$')
  if count then
    held = held + tonumber(count)
  end
end

if held + seat_count > max_seats then
  return {'HOLD_LIMIT_EXCEEDED', tostring(held)}
end

-- 3. All-or-nothing pre-check. On the first occupied seat we return without
--    having written anything, so no partial hold can exist.
local seat_key_start = 3
for i = 0, seat_count - 1 do
  if redis.call('EXISTS', KEYS[seat_key_start + i]) == 1 then
    return {'SEAT_CONFLICT', KEYS[seat_key_start + i]}
  end
end

-- 4. Commit. Every write below is guaranteed to run: the script holds the
--    single Redis thread and has already validated all preconditions.
local seat_ids = cjson.decode(seat_ids_json)
for i = 0, seat_count - 1 do
  redis.call('SET', KEYS[seat_key_start + i], user_id .. ':' .. hold_id, 'EX', ttl)
end

local meta = cjson.encode({
  holdId = hold_id,
  userId = user_id,
  showId = show_id,
  seatIds = seat_ids,
  expiresAt = expires_at
})
redis.call('SET', meta_key, meta, 'EX', ttl)
redis.call('ZADD', user_holds_key, now_ms + ttl * 1000, hold_id .. ':' .. seat_count)

return {'OK', hold_id, tostring(held + seat_count)}
`;

/**
 * RELEASE - frees one hold, but only for the user who owns it.
 *
 * The per-seat step is compare-and-delete: a seat is removed only when its
 * current value is exactly {userId}:{holdId}. A bare DEL would let one user
 * release another user's hold, or delete a lock that had already been
 * re-acquired after an expiry (invariant 5).
 *
 * A missing meta key is the normal outcome for an expired or already-released
 * hold, so it is reported rather than treated as an error.
 */
export const RELEASE_HOLD_SCRIPT = `
local requester = ARGV[1]

local raw = redis.call('GET', KEYS[1])
if not raw then
  return {'HOLD_NOT_FOUND'}
end

local meta = cjson.decode(raw)

-- Ownership is checked before any write. A non-owner gets the same answer as a
-- missing hold, so the endpoint cannot be used to discover that a hold exists.
if meta.userId ~= requester then
  return {'HOLD_NOT_FOUND'}
end

local released = 0
for i = 1, #meta.seatIds do
  local seat_key = 'hold:' .. meta.showId .. ':' .. meta.seatIds[i]
  local expected = meta.userId .. ':' .. meta.holdId
  if redis.call('GET', seat_key) == expected then
    redis.call('DEL', seat_key)
    released = released + 1
  end
end

redis.call('ZREM', 'user_holds:' .. meta.userId .. ':' .. meta.showId,
           meta.holdId .. ':' .. tostring(#meta.seatIds))
redis.call('DEL', KEYS[1])

return {'OK', tostring(released)}
`;
