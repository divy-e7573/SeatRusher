# ADR 0002: Database schema and the double-booking unique index

- **Status:** Accepted
- **Phase:** 1 - Database & Read APIs
- **Date:** 2026-10-23

## Context

SeatRush must never sell the same seat twice. The PRD puts the final gate in the
database: a partial unique index on `booking_seats (show_id, seat_id)` covering active
bookings (AGENTS.md invariant 2). Redis holds and application logic are performance
layers; if they fail, this index is what still makes double-booking impossible.

Getting there forced three concrete decisions: how the index predicate is expressed,
how money is stored, and how integration tests get a database without corrupting
development data.

## Decision

### 1. booking_seats.status is denormalized from bookings.status

The index lives in a hand-written migration:

```sql
CREATE UNIQUE INDEX booking_seats_active_show_seat_key
    ON booking_seats (show_id, seat_id)
    WHERE status IN ('PENDING', 'CONFIRMED');
```

The obvious alternative is to filter through the parent row:
`WHERE booking_id IN (SELECT id FROM bookings WHERE status IN (...))`. Postgres cannot
use a **partial unique index whose predicate references another table**, so that shape
would force the database to check bookings on every insert and could not be enforced as
an index at all.

So `booking_seats` carries its own `status` column, kept equal to `bookings.status`
inside the same transaction. The predicate becomes a pure expression on one table and
enforcement stays a fast index lookup.

Consequence: writing a booking seat requires setting the same status twice. Phase 6
confirmation must update both rows in its transaction; a helper on the repository will
make that hard to get wrong.

### 2. The index covers PENDING, not just CONFIRMED

A checkout creates a `PENDING` booking before payment is confirmed. If only CONFIRMED
rows were indexed, two concurrent checkouts for the same seat would both insert a
PENDING row and only one would later fail at confirmation time - after the user had
already been charged. Treating PENDING as occupying the seat makes the database reject
the second checkout up front, which is where the 409 belongs.

EXPIRED, CANCELLED and REFUND_REQUIRED sit outside the predicate, so a failed attempt
frees the seat again without any cleanup job.

### 3. Money is stored as integer paise

`amount_paise`, `price_paise` and `total_amount_paise` are integers (1 rupee = 100
paise). Floating-point money accumulates rounding errors; `decimal` in JS arrives as a
string and forces parsing rules on every consumer. Integers serialize cleanly to JSON.

### 4. Prisma 6.19.3 with a hand-written migration for the partial index

Prisma's schema language has no `WHERE` clause on indexes, so the index lives in
`prisma/migrations/20261023052232_partial_unique_booking_seats/migration.sql`.
`prisma migrate dev` accepts it and reports the database in sync: an extra index is not
a drift Prisma tries to remove. Never edit an applied migration - future schema changes
get a new one.

Prisma 7 was rejected for now: it requires Node `^22.18` (this machine runs 22.15), its
CLI wants a driver adapter instead of `provider = postgresql` plus `url`, and the
`latest` tag is currently an 8.0 release candidate. 6.19.3 is the newest stable line
that works as documented.

### 5. Integration tests run in their own Postgres schema

`prisma migrate deploy` plus the seed run against `seatrush_test` on the same database
(`?schema=seatrush_test`, created automatically). Tests that prove the constraint need
to write bookings; doing that in the development schema would corrupt the availability
counts the read APIs display. One command prepares it:

```bash
pnpm --filter api db:test:prepare
```

Same engine, same migrations, same constraints, zero interference with dev data. Redis
is shared, but every key is namespaced by show id, and cache tests delete the keys they
assert on.

### 6. Cache policy: split TTLs by how fast the data changes

- `seat:layout:{showId}` - **no TTL**. A screen's physical layout is immutable, so the
  entry can never be stale; only explicit invalidation removes it.
- `show:detail:{showId}` - **300 s TTL**. It embeds the available-seat count, which
  drifts as bookings are made. The short TTL lets it self-heal instead of depending on
  every future write path to remember to invalidate it.

Seat **status** is never cached. `GET /shows/:id/seats` merges the cached layout with a
fresh Postgres read of active `booking_seats`, so a booked seat can never be served as
available because of a stale entry.

Invalidation helpers (`invalidateShow`, `clearAllShowCaches`) are explicit so later
phases have one obvious place to hook into; `clearAllShowCaches` uses SCAN, never KEYS,
which would block the Redis event loop.

## Consequences

**Good**

- Double-booking is impossible at the storage layer, verified by tests that assert
  Prisma error `P2002` and by the API mapping it to HTTP 409.
- The index is fast: predicate and key columns are all on `booking_seats`.
- Failed or cancelled attempts automatically free seats; no reaper is needed for
  correctness.
- Money never suffers float rounding, and test data can never damage development data.

**Costs and accepted risks**

- Status is duplicated between `bookings` and `booking_seats`; the repository must keep
  them in lockstep (checked in tests, enforced by convention until Phase 6 adds the
  transactional update helper).
- The partial index is invisible to Prisma's schema language, so it is not visible in
  `schema.prisma` - only in the migration and a comment on the model. Anyone pruning
  migrations by reading the schema alone could delete the project's safety net.
- Two `UUID` columns per row is more storage than integers, accepted for safety: an id
  copied from the wrong environment fails loudly instead of silently colliding.
- Availability counts on the show list are computed per request, which is fine for
  hundreds of shows and will need a cached count if that changes (noted for Phase 6+).
