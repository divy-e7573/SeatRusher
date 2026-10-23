# ADR 0004: Seat-hold locking strategy

- **Status:** Accepted
- **Phase:** 3
- **Date:** 2026-10-23

## Context

FR-3 requires a user to hold at most 6 seats per show, a multi-seat hold to be
all-or-nothing, and only the owner to release a hold. The interesting part is
not the rules but the concurrency: many users will claim the same seat at the
same moment, and every rule above has to hold _across_ those simultaneous
attempts rather than within a single one.

The naive implementation fails:

```
if (await redis.get(key) === null) {   // everyone sees "free"
  await redis.set(key, me);            // everyone writes
}
```

Between the GET and the SET another request can write. This is the check-then-act
race AGENTS.md invariant 3 forbids, and it would hand the same seat to two users.

## Decision

### 1. Redis is the hold store, but never the source of truth

A hold is a _fast, temporary_ reservation. The durable guarantee remains the
partial unique index on `booking_seats (show_id, seat_id)` for active bookings
(invariant 2). Concretely:

- `POST /shows/:id/holds` checks Postgres for active bookings **before** Redis.
  A seat that is already sold returns 409 and never reaches Redis.
- Checkout (Phase 6) re-verifies inside a transaction and still relies on the
  index, so even a total Redis failure cannot produce a double booking.
- Redis losing every key means holds are forgotten, not corrupted: seats become
  available again, which is the safe direction to fail.

### 2. One Lua script per operation

Both operations are single Lua scripts in
`apps/api/src/modules/holds/holds-scripts.ts`. Redis executes a script to
completion on one thread, so no other command can interleave between the check
and the write. That is the entire locking mechanism - there is no lock object, no
lease, and no coordinator.

`ACQUIRE_HOLD_SCRIPT` runs in this order:

1. `ZREMRANGEBYSCORE` to drop expired bookkeeping.
2. Sum the seats the user already holds for this show (the 6-seat cap).
3. Verify _every_ requested seat key is free; abort on the first that is not.
4. Write all seat keys, the metadata key and the ZSET entry.

Steps 1-3 return without writing anything, so a rejected request leaves no
trace; step 4 has no failure path left. Scripts are invoked with `EVALSHA` and
fall back to `EVAL` on `NOSCRIPT` (Redis restart or `SCRIPT FLUSH`).

`RELEASE_HOLD_SCRIPT` reads the metadata, verifies ownership, then
compare-and-deletes each seat: a key is removed only when its value is exactly
`{userId}:{holdId}`. A bare `DEL` would let one user free another user's lock,
or delete a seat that was already re-acquired after an expiry (invariant 5).

### 3. Why Lua and not Redlock

Redlock coordinates independent Redis masters through a quorum. This system has
**one** Redis and does not need to survive its failover:

- Redis down must fail closed (invariant 9), which we want by _refusing_
  requests, not by negotiating a new master. A hold lost to failover is
  recovered by its TTL, and a hold wrongly granted is caught by the Postgres
  unique index at checkout.
- Redlock's own safety argument is disputed (the "gods" / Kleppmann
  analysis): clock drift and GC pauses can break mutual exclusion under load.
  A single-node Lua script gives a _simpler and stronger_ guarantee here - one
  thread, no leases.
- Operational cost: N masters plus quorum monitoring buys nothing for a
  single-instance dev stack, and the complexity would be pure overhead.

The trade-off accepted: if Redis is lost wholesale, in-flight holds are lost
early. Users see seats released sooner than 10 minutes. The alternative -
stale holds nobody can release - is worse.

### 4. Bookkeeping that cannot leak

`user_holds:{userId}:{showId}` is a ZSET, not a set, with the score set to the
expiry timestamp in epoch milliseconds and the member being `{holdId}:{seatCount}`.
A plain set cannot express a per-member TTL, so an abandoned entry would
permanently consume a user's 6-seat allowance. With a ZSET a single
`ZREMRANGEBYSCORE ... -inf now` at the top of every acquire removes all expired
entries, so crash leftovers and normal expiry are handled by the same line of
code.

### 5. Fail closed, and never guess

- Redis unreachable -> `POST` and `DELETE` return 503 `HOLDS_UNAVAILABLE`.
  A hold request is never silently skipped.
- The seat map (`GET /shows/:id/seats`) merges Postgres bookings with live hold
  keys and applies **BOOKED > HELD > AVAILABLE**. Booked wins because Postgres
  is the source of truth.
- If the hold read fails, the endpoint returns 503 rather than reporting every
  seat as AVAILABLE, which would invite a doomed checkout. This is the one case
  where a read API fails on purpose, and it is why the cache outage and the
  hold-status outage are handled differently: a missing _cache_ degrades to
  Postgres, an unknown _hold status_ does not.
- Status is never cached. Only the immutable layout (`seat:layout:{showId}`)
  is, exactly as in Phase 1.

### 6. Ownership and identity

`userId` is taken from the verified access token only; the request body has no
field for it. A release by a non-owner returns the same 404 as a missing hold,
so the endpoint cannot confirm that someone else's hold exists. Hold ids are
random UUIDs and are returned only to their owner.

## Consequences

- Easier: the concurrency rules are written once, in one place, and are
  provably independent of request interleaving. Releasing cannot touch another
  user's lock. No lock can outlive its TTL.
- Harder: two scripts must be kept in step with `holds-repository.ts`, and any
  new hold operation needs its own script. Lua is not unit-testable in
  isolation, so correctness is proven through integration tests against real
  Redis.
- Accepted: `GET /shows/:id` still reports `availableSeats` from Postgres
  bookings only, so it does not immediately reflect holds. Correcting it would
  make a 5-minute cached value depend on Redis and would contradict ADR 0002's
  cache split; it is deferred to the phase that owns show-detail caching.
