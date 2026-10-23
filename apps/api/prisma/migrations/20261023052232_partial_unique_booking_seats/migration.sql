-- This is an empty migration.
-- Double-booking guard (AGENTS.md invariant 2, PRD 6.2).
--
-- At most ONE active booking_seats row may exist for a given (show_id, seat_id).
-- "Active" means PENDING (checkout started, payment not confirmed) or CONFIRMED
-- (paid). Rows for EXPIRED / CANCELLED / REFUND_REQUIRED bookings are outside the
-- predicate, so a failed or cancelled attempt never permanently blocks a seat.
--
-- Why a hand-written migration: Prisma's schema language cannot express a partial
-- index (WHERE clause), so it is invisible to `prisma migrate dev`'s diff. The
-- index is still created and enforced by Postgres, which is the real guarantee.
-- `booking_seats.status` is denormalized from `bookings.status` precisely so this
-- predicate is a pure expression on one table - no join, no subquery.
-- Rationale: docs/adr/0002-database-schema-and-unique-index.md
CREATE UNIQUE INDEX "booking_seats_active_show_seat_key"
    ON "booking_seats" ("show_id", "seat_id")
    WHERE "status" IN ('PENDING', 'CONFIRMED');
