# PRD: High-Frequency Real-Time Ticketing System

Working name: **SeatRush** (change freely)

## 1. Overview

A BookMyShow / Ticketmaster-style ticketing system that stays correct under **high concurrency**. Even when thousands of users try to book the same show's seats at the same time:

- a seat is given to exactly one user,
- all other users see seat status in real time,
- a temporary hold lasts 10 minutes and the seat is released automatically afterwards,
- payment and booking stay consistent even if a server crashes or a webhook arrives late.

This is a **learning and portfolio project**. The focus is concurrency, distributed locks, DB transactions, real-time sync, and failure handling. UI polish is secondary.

## 2. Goals

1. Zero double-bookings under load (proven with k6).
2. Seat status changes reach all connected clients in under 300 ms.
3. A clear two-layer design: Redis (fast holds) + PostgreSQL (durable truth).
4. Every failure case is documented and tested.
5. A clean README and ADRs so the design can be explained confidently in interviews.

## 3. Non-Goals

- Real money payments (mock gateway; Razorpay test mode is an optional stretch).
- Multi-city, multi-cinema admin panel, recommendations, reviews.
- Mobile app.
- Microservices. This is a **modular monolith**.

## 4. Personas

| Persona | Need |
|---|---|
| Customer | Browse shows, pick seats, pay within 10 minutes, receive a ticket |
| Admin (minimal) | Seed shows/venues/seat layouts, view bookings |
| Interviewer/Reviewer | Understand design decisions and load test results |

## 5. Tech Stack

| Layer | Choice |
|---|---|
| Frontend | Next.js (App Router), React, TypeScript, Tailwind, Zustand/TanStack Query |
| Backend | Node.js, TypeScript, Fastify (or Express), Socket.IO |
| Primary DB | PostgreSQL (Prisma ORM, raw SQL for critical queries) |
| Cache / Locks | Redis (ioredis, Lua scripts) |
| Queue | BullMQ (delayed jobs) |
| Realtime | Socket.IO + `@socket.io/redis-adapter` |
| Testing | Vitest/Jest, Supertest, k6 (load) |
| Infra | Docker Compose (local), GitHub Actions (CI) |
| Repo | pnpm monorepo: `apps/web`, `apps/api`, `packages/shared` |

## 6. Core Domain

### 6.1 Seat state machine (per show)

```
AVAILABLE --hold--> HELD --payment success--> BOOKED
    ^                 |
    +--expiry/release-+
```

- `HELD` lives **in Redis** (with a TTL).
- `BOOKED` lives **in PostgreSQL** (permanent).
- Effective seat state = BOOKED in Postgres? -> BOOKED; else held in Redis? -> HELD; else AVAILABLE.

### 6.2 Entities

- `users`
- `venues`, `screens`, `seats` (physical layout: row, number, category)
- `shows` (movie/event, screen, start_time, price per category)
- `bookings` (user, show, status: `PENDING | CONFIRMED | EXPIRED | CANCELLED | REFUND_REQUIRED`, total, expires_at)
- `booking_seats` (booking_id, show_id, seat_id, price)
- `payments` (booking_id, provider_ref, status, idempotency_key)
- `processed_webhooks` (unique event_id, for idempotency)

**Critical constraint:** a partial unique index on `booking_seats (show_id, seat_id)` where the booking status is active (`PENDING`/`CONFIRMED`). This prevents double-booking at the DB level even if Redis fails.

## 7. Functional Requirements

### FR-1 Auth
- Register/login (JWT access + refresh), password hashing (argon2/bcrypt).
- WebSocket connections are authenticated with JWT.

### FR-2 Browse
- Shows list, show detail, seat layout with live status.
- Static layout data is cached (Redis + HTTP cache); live status is merged in separately.

### FR-3 Seat Hold (Redis lock)
- A user can hold at most **6 seats** per show.
- Multi-seat hold is **all-or-nothing** (atomic Lua script).
- Key: `hold:{showId}:{seatId}` = `{userId}:{holdId}`, TTL = 600s.
- Only the owner can release (compare-and-delete Lua).
- `hold_meta:{holdId}` stores the seats and expiry timestamp.

### FR-4 Real-Time Sync
- One Socket.IO room per show: `show:{showId}`.
- Events: `seat:held`, `seat:released`, `seat:booked`, `seat:selecting` (optional soft hint when a user hovers/clicks a seat), `hold:expiring` (sent to the holder).
- Full snapshot resync on reconnect.
- Safe across multiple instances (Redis adapter).

### FR-5 Expiry & Release
- When a hold expires, the seat is released and the change is broadcast.
- Primary: a BullMQ delayed job per hold. Backup: a periodic reconciler/sweeper. Redis keyspace notifications must **not** be the sole mechanism because they are unreliable.
- The frontend shows a countdown driven by the server's `expires_at`, not the client clock.

### FR-6 Checkout & Payment
- Checkout: verify a valid hold, then create a `PENDING` booking plus `booking_seats` in a single transaction.
- Mock payment gateway: create order, simulate success/failure, send a webhook.
- The webhook handler is idempotent.
- On success, in one transaction: `SELECT ... FOR UPDATE` on the booking row, verify status, mark `CONFIRMED`, clean the Redis hold, broadcast `seat:booked`.

### FR-7 Failure Handling (must-have)
| Scenario | Expected behavior |
|---|---|
| Hold expires while payment is in progress | After payment success, check Postgres: if the seat is still free, confirm; otherwise `REFUND_REQUIRED` |
| Server crash after Redis hold | Released by TTL; reconciler cleans up |
| Redis down | New holds rejected (fail closed), existing bookings safe, clear error |
| Duplicate / late / out-of-order webhook | Idempotent, handled according to the state machine |
| Two users, same seat, same millisecond | Exactly one succeeds, the other gets 409 |
| User closes the tab | Hold stays until TTL, or is released on disconnect (configurable) |

### FR-8 Caching & Protection
- Show/layout cache with invalidation.
- Rate limiting (per user/IP) on hold and checkout endpoints.
- Optional: virtual waiting room / queue for hot shows (stretch).

## 8. Non-Functional Requirements

| Area | Target |
|---|---|
| Correctness | 0 double-bookings in load test (10k+ concurrent attempts) |
| Hold API latency | p95 < 100 ms at 500 rps (local) |
| Realtime latency | seat event broadcast p95 < 300 ms |
| Availability | Stateless API, horizontally scalable (tested with 2+ instances) |
| Observability | Structured logs (pino), request IDs, basic metrics endpoint |
| Security | Input validation (zod), rate limits, no secrets in repo |

## 9. API Surface (draft)

```
POST   /auth/register | /auth/login | /auth/refresh
GET    /shows
GET    /shows/:id
GET    /shows/:id/seats            # layout + live status snapshot
POST   /shows/:id/holds            # body: { seatIds: [] }
DELETE /holds/:holdId
POST   /holds/:holdId/checkout     # creates PENDING booking + payment order
POST   /payments/webhook           # mock gateway callback (signature verified)
GET    /bookings/me
GET    /bookings/:id
```

WebSocket (`/socket.io`): client `join:show`, `leave:show`, `seat:selecting`; server `seat:held`, `seat:released`, `seat:booked`, `hold:expiring`, `snapshot`.

## 10. Success Metrics / Acceptance

1. k6 test: N users contend for one seat; exactly 1 succeeds, the rest get 409.
2. k6 test: mixed load on random seats; final DB has 0 duplicate `(show_id, seat_id)`.
3. Chaos test: kill the API process during hold/payment; the system recovers consistently.
4. With two API instances, WebSocket events reach clients connected to either one.
5. README includes an architecture diagram, ADRs, and load test results.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Treating the Redis lock as the sole source of truth | The Postgres unique index and transaction are always the final gate |
| Missed expiry events | BullMQ + sweeper together |
| Clock skew | Use server-side timestamps only |
| Scope creep (payments, admin) | Strictly follow the non-goals |

## 12. Deliverables

- Working app (web + api), runnable with one docker-compose command.
- Test suite (unit + integration + concurrency).
- k6 scripts + results report.
- `docs/adr/` (design decisions) and a `README.md` with diagrams.
