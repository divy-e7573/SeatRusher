/**
 * Booking lifecycle values shared with the API and web.
 *
 * These mirror the `BookingStatus` enum in `apps/api/prisma/schema.prisma`. They
 * live here because BOTH sides need them: the API filters by them in queries, and
 * the web app must render the same seat states from them in Phase 7.
 */
export const BOOKING_STATUS = {
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
  REFUND_REQUIRED: 'REFUND_REQUIRED',
} as const;

export type BookingStatus = (typeof BOOKING_STATUS)[keyof typeof BOOKING_STATUS];

/**
 * Statuses that occupy a seat.
 *
 * This exact list is the predicate of the `booking_seats_active_show_seat_key`
 * partial unique index - the database-level guarantee that a seat cannot be sold
 * twice. PENDING occupies it because a started-but-unpaid checkout already holds
 * the seat until its hold expires.
 */
export const ACTIVE_BOOKING_STATUSES = [BOOKING_STATUS.PENDING, BOOKING_STATUS.CONFIRMED] as const;

export type ActiveBookingStatus = (typeof ACTIVE_BOOKING_STATUSES)[number];
