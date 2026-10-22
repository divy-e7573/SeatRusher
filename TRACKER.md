# TRACKER.md

Live progress tracker for SeatRush. Update this file after each task and at the end of every phase.

**Working mode:** Fresh restart from Phase 0. Implement and learn one phase at a time, using Codex for implementation and ChatGPT for review/explanation.
**Current phase:** Phase 0 — Setup & Foundation (implemented and locally verified; awaiting user review)
**Last updated:** 2026-10-23
**Status legend:** `[ ]` not started, `[~]` in progress, `[x]` implemented and verified

## Required Workflow (must follow)

1. Treat this as a fresh project restart beginning at Phase 0. Do not skip to a later phase just because older tracker entries or code exist.
2. Preserve Git history and the user's existing work. Never delete/reset the repository or discard changes blindly. Before changing files, inspect `git status` and explain any destructive/replacement steps; prefer a clean new branch or a backup when appropriate.
3. Work on one phase at a time. Before implementation, give a concise plan listing the intended changes and tests.
4. Use `PRD.md` as the product specification and this file as the phase tracker. Follow `AGENTS.md` coding and architecture rules. Ask before changing major decisions or adding scope.
5. The user will run the phase prompt in Codex and share Codex's implementation/review report with ChatGPT. The user and ChatGPT will review correctness, tests, risks, and understanding before proceeding.
6. At the end of each phase, produce a **Phase Handoff Summary** explaining: what was implemented, important files/functions, how the code flow works, key design decisions, exact tests/commands and results, known limitations, and what the user should personally inspect/understand.
7. Do not begin the next phase until the current phase's implementation, tests, documentation, and handoff have been reviewed and the user agrees to proceed.
8. Mark `[x]` only when implementation and evidence are verified. Use `[~]` for partial work or work awaiting verification. Never claim a test passed unless it actually ran and passed.
9. Update this tracker and relevant ADR/docs at the end of each phase. Keep historical decision entries for reference, but re-check whether they still apply during the fresh restart.
10. Never expose `.env` secret values or commit credentials.

## Phase Handoff Checklist

- [ ] Phase requirements compared against `PRD.md`
- [ ] Changed files and important functions explained in beginner-friendly language
- [ ] Request/data flow and design decisions explained
- [ ] Tests added/updated and exact results reported
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, and build run where available
- [ ] Relevant integration, concurrency, and failure-path tests run where applicable
- [ ] Security, race conditions, edge cases, and known limitations reviewed
- [ ] `TRACKER.md` and relevant ADR/docs updated
- [ ] User has shared and discussed the Codex report with ChatGPT
- [ ] User has approved moving to the next phase

---

## Phase 0: Setup & Foundation
- [x] pnpm monorepo (`apps/api`, `apps/web`, `packages/shared`)
- [x] TypeScript strict, ESLint, Prettier, Vitest config
- [x] `docker-compose.yml` (Postgres + Redis)
- [x] Env config with zod validation, `.env.example`
- [x] Fastify server skeleton + `/health` (checks Postgres + Redis)
- [x] pino logger + requestId
- [x] GitHub Actions CI (lint, typecheck, test)
- [x] Docs folder + first ADR (stack choice)
- [x] Root README (prerequisites, setup, env, docker, commands, verification)

### Phase 0 verification record (2026-10-23)

All commands below were actually executed on Windows / Node v22.15.0 / pnpm 10.33.0 /
Docker Desktop 29.5.3.

| # | Check | Command | Result |
|---|---|---|---|
| 1 | Dependency install | `pnpm install` | **PASS** — 236 packages, no peer errors. |
| 2 | Compose config valid | `docker compose config --quiet` | **PASS** — exit 0, services `postgres`, `redis`. |
| 3 | Infra up + healthy | `docker compose up -d --wait` | **PASS** — both containers `healthy`; `pg_isready` accepts connections, `redis-cli ping` → `PONG`. |
| 4 | API boots, `/health` 200 | `node dist/index.js` + `curl /health` | **PASS** — HTTP 200, `status:"ok"`, postgres 23 ms / redis 14 ms. |
| 5 | Lint | `pnpm lint` | **PASS** — exit 0, no findings. |
| 6 | Typecheck | `pnpm typecheck` | **PASS** — exit 0 across all 3 packages. |
| 7 | Tests | `pnpm test` | **PASS** — 3 files, 24 tests, 0 failures. |
| 8 | Build | `pnpm build` | **PASS** — shared + api via `tsc`, web via `next build` (Turbopack). |

Extra behaviour verified by hand against the running compiled server:

- `GET /nope` → HTTP 404 with `{"error":{"code":"NOT_FOUND","message":...,"requestId":...}}`.
- Every log line carries `reqId`; an inbound `x-request-id: my-trace-42` is echoed in the
  response header and appears as `reqId` in the log lines.
- `/health` returns 503 + `degraded` with the failing dependency named (covered by tests).

#### Commands that failed during Phase 0, and how they were resolved

| Failure | Cause | Resolution |
|---|---|---|
| `pnpm ping` / `npm ping` hung; `Invoke-WebRequest` returned nothing | npm registry is blocked inside the default sandbox | Re-ran network-touching commands with approved escalation. Registry reachable (`status=200`). |
| `docker version` → `npipe ... dockerDesktopLinuxEngine: cannot find the file` | Docker daemon not running | Started Docker Desktop; daemon reported `Server=29.5.3`. |
| `pnpm typecheck` — `Cannot use namespace 'Redis' as a type` (ioredis 6) | ioredis 6 is CJS; the default-import shape does not typecheck under NodeNext ESM | Use the named export the package provides explicitly: `import { Redis } from 'ioredis'`. |
| `pnpm typecheck` — `FastifyInstance<…, Logger>` not assignable to `FastifyInstance` | Fastify's bare alias defaults the Logger parameter to the wider `FastifyBaseLogger` | Added a named `SeatrushFastifyInstance` type in `lib/logger.ts` that fixes the Logger parameter to pino's `Logger`. |
| `pnpm test` — `password authentication failed for user "seatrush"` | A **native** `postgresql-x64-18` Windows service already owns port 5432, so `localhost:5432` never reached the container | Verified containers are correct from inside (`psql` succeeds). Ran the stack on `POSTGRES_PORT=55432` / `REDIS_PORT=56379` for local verification. Committed defaults stay 5432/6379; README documents the override. |
| `pnpm test` — `x-request-id` header `undefined` | Fastify 5 reads an inbound request id but does not echo one on the response | Added an `onRequest` hook that sets `x-request-id` from `request.id`. |
| Test output: `FastifyDeprecation: disableRequestLogging option is deprecated` | Passing `disableRequestLogging: false` explicitly is redundant | Removed the option (false is the default); warning gone and the code is future-proof for Fastify 6. |

#### Phase 0 interpretation notes

- `docker-compose.yml` contains **only** PostgreSQL and Redis, exactly as the Phase 0
  brief specifies. The apps therefore run on the host via `pnpm dev`, which the README
  documents. The `Definition of Done` line "App runs via `docker compose up`" is read as
  "the infrastructure comes up via `docker compose up`" for this phase; a compose file
  that also builds/runs the apps was not requested and is deliberately not there yet.
- `docker-compose.yml` sits at the repository root rather than in `infra/`, because the
  brief asks for a root file and `AGENTS.md` documents `docker compose up -d` with no
  `-f` flag. `infra/README.md` records the deviation and reserves `infra/k6/` for Phase 9.
- **TypeScript pinned to 5.9.3, not the latest 7.0.2.** `typescript-eslint@8` declares a
  peer range of `>=4.8.4 <6.1.0`; pairing it with TS 7 is unsupported and disables the
  lint rules the project relies on.

## Phase 1: Database & Read APIs
- [ ] Prisma schema (`users`, `venues`, `screens`, `seats`, `shows`, `bookings`, `booking_seats`, `payments`, `processed_webhooks`)
- [ ] Partial unique index on `booking_seats (show_id, seat_id)` for active bookings — raw SQL migration `0002_partial_unique_booking_seats`
- [ ] Migrations applied through `db:migrate` (pg-based runner, Prisma-compatible SQL)
- [ ] Seed script (`pnpm --filter api db:seed`): 1 venue, 1 screen with 150 seats (rows A-J, categories regular/premium), 3 shows
- [ ] `GET /shows`, `GET /shows/:id`, `GET /shows/:id/seats`
- [ ] Layout cache in Redis (`seat:layout:{showId}`, `show:detail:{showId}`) with explicit invalidation hooks
- [ ] Integration tests against real Postgres (and Redis for cache assertions)
- [ ] DB-level test proving the partial unique index rejects duplicate active `(show_id, seat_id)` rows
- [ ] ADR 0002 — schema + partial unique index rationale

## Phase 2: Authentication
- [ ] Register / login / refresh
- [ ] Password hashing
- [ ] Auth middleware (JWT)
- [ ] Rate limit on auth routes
- [ ] Tests

## Phase 3: Redis Seat Hold (Core)
- [ ] Redis key design + constants
- [ ] Lua: atomic multi-seat hold (all-or-nothing)
- [ ] Lua: owner-only release
- [ ] `POST /shows/:id/holds` (max 6 seats, 10 min TTL)
- [ ] `DELETE /holds/:holdId`
- [ ] Seat status merge (Postgres BOOKED + Redis HELD) in seat snapshot API
- [ ] Concurrency tests (N parallel -> exactly 1 success)
- [ ] ADR: locking strategy (why Lua, why not Redlock)

## Phase 4: Real-Time Sync (WebSockets)
- [ ] Socket.IO gateway with JWT auth
- [ ] Rooms per show, join/leave
- [ ] Broadcast `seat:held`, `seat:released`
- [ ] Soft `seat:selecting` hint
- [ ] Snapshot on (re)connect
- [ ] Redis adapter, tested with 2 API instances
- [ ] Tests (socket integration)

## Phase 5: Expiry & Release
- [ ] BullMQ delayed job per hold
- [ ] Expiry worker (release + broadcast)
- [ ] Sweeper/reconciler (backup)
- [ ] `hold:expiring` warning event
- [ ] Tests (fast TTL in test env)
- [ ] ADR: why not keyspace notifications alone

## Phase 6: Checkout, Payment & Booking
- [ ] `POST /holds/:id/checkout` -> PENDING booking (transaction)
- [ ] Mock payment gateway + signed webhook
- [ ] Idempotent webhook handler
- [ ] Confirm booking transaction (FOR UPDATE, isolation level)
- [ ] Late-payment / expired-hold handling (`REFUND_REQUIRED`)
- [ ] Failure scenario tests (PRD FR-7)
- [ ] `GET /bookings/me`, `GET /bookings/:id`
- [ ] ADR: transaction isolation & consistency model

## Phase 7: Frontend
- [ ] Next.js setup, auth pages
- [ ] Shows list + detail
- [ ] Seat map component (states: available/held/mine/booked)
- [ ] WebSocket integration (live updates, reconnect resync)
- [ ] Hold flow + 10 min server-driven countdown
- [ ] Checkout + mock payment flow
- [ ] My bookings page
- [ ] Error/edge states (409 conflict, expiry, disconnect)

## Phase 8: Hardening
- [ ] Rate limiting on hold/checkout
- [ ] Redis-down fail-closed behavior + test
- [ ] Graceful shutdown
- [ ] Metrics endpoint / basic observability
- [ ] Security review (validation, headers, CORS)
- [ ] (Stretch) Virtual waiting room

## Phase 9: Load & Chaos Testing
- [ ] k6: same-seat contention
- [ ] k6: mixed random load
- [ ] Assert 0 duplicates in DB after run
- [ ] Chaos: kill API mid-hold/payment
- [ ] 2-instance test
- [ ] Results report in `docs/load-test.md`

## Phase 10: Polish & Ship
- [ ] README (architecture diagram, sequence diagrams, setup)
- [ ] All ADRs complete
- [ ] Demo GIF/video
- [ ] Deployment (optional)
- [ ] Interview Q&A notes (`docs/interview-notes.md`)

---

## Historical Decisions Log (re-validate during the fresh restart)
| Date | Decision | Why |
|---|---|---|
| 2026-10-23 | Re-confirmed on the fresh restart: Fastify + Vitest, unscoped package names (`api`, `web`, `shared`), Node 22, NodeNext ESM with `.js` import extensions, ESLint `recommended` (no type-checked rules), `pg` Pool (not Prisma) for the `/health` probe, env in `apps/api/.env` loaded by dotenv. | All still match the Phase 0 implementation and remain sound; no change needed. |
| 2026-10-23 | Pinned **TypeScript 5.9.3** instead of the current latest 7.0.2. | `typescript-eslint@8.72.0` peers `typescript >=4.8.4 <6.1.0`. TS 7 is outside that range, so the install would be unsupported and the `@typescript-eslint` rules the project depends on would be unavailable. Revisit when typescript-eslint supports TS 7. |
| 2026-10-23 | `/health` echoes the request id via an `onRequest` hook setting `x-request-id`. | Fastify 5 consumes an inbound `requestIdHeader` but does not write the id back on the response. Echoing it is what makes the `requestId` in the error envelope traceable from a user's HTTP client. |
| 2026-10-23 | HTTP tests use Fastify's built-in `app.inject()`; Supertest not added. | It is Fastify's own request driver, so it adds no new coverage. Adds a dependency only if a future phase needs real sockets. |
| 2026-10-23 | Compose host ports made overridable via `${POSTGRES_PORT:-5432}` / `${REDIS_PORT:-6379}`. | A native PostgreSQL service on the dev machine owns 5432. The override keeps the committed defaults standard while making the collision solvable without editing the file. |
| 2026-10-01 | Stack: Fastify + Vitest; frontend TanStack Query + Zustand (Phase 7). See ADR 0001. | AGENTS.md is the tie-breaker where PRD lists options. |
| 2026-10-01 | Node pinned to **22 LTS** (`.nvmrc` = 22, `engines.node` >= 22), not 24. | 22 is the LTS installed on the dev machine; pinning 24 would break local `pnpm install`. Revisit if standardizing on 24. |
| 2026-10-01 | Workspace package names are **unscoped** (`api`, `web`, `shared`). | Keeps the documented `pnpm --filter api <script>` commands working literally. |
| 2026-10-01 | `/health` Postgres probe uses a minimal `pg` Pool, not Prisma. | Keeps Prisma fully inside Phase 1; consolidation decided then. |
| 2026-10-01 | Env lives in `apps/api/.env` (+ `.env.example`), loaded via `dotenv`. | The API is the only consumer in Phase 0; CI injects env directly. |
| 2026-10-01 | ESLint flat config uses the lighter `recommended` set (no type-checked rules). | Faster CI; tighten later if needed. `no-explicit-any` kept as an error. |
| 2026-10-01 | ESM via `NodeNext`; relative imports use explicit `.js` extensions. | Required by `NodeNext` module resolution. |
| 2026-10-08 | Partial unique index declared on `booking_seats (show_id, seat_id) WHERE status IN ('PENDING','CONFIRMED')`. | Per PRD 6.2 invariant: index must span active rows so cancelled/expired/refunded rows do not free a seat that is still notionally "available" only by accident. Status is denormalized into `booking_seats.status` so the index does not need to join `bookings`. See ADR 0002. |
| 2026-10-08 | `booking_seats.status` denormalized from `bookings.status` (kept in sync inside the same transaction). | Required for the partial unique index to be expressible in plain SQL without an `EXISTS` subquery, and to keep the index predicate a pure expression on the indexed table. |
| 2026-10-08 | Authored canonical `schema.prisma` but used the already-installed `pg` driver at runtime. | This sandbox has no network access to the npm registry, so `pnpm add prisma` cannot succeed; the schema and SQL are still Prisma-compatible so the runtime layer can be swapped to `@prisma/client` in any environment where Prisma is available (CI runs the same migrations against real Postgres, so the divergence is only data-access, not library or schema). |
| 2026-10-08 | Custom `db:migrate` runner (`apps/api/src/lib/db-migrate.ts`) replays ordered SQL files under `apps/api/prisma/migrations/`. | The `prisma migrate dev` engine requires the Prisma binary; this fallback applies the same SQL so tests do not depend on Prisma being installed. Idempotent (tracks applied filenames in `_seatrush_migrations`). |
| 2026-10-08 | Layout cache: `seat:layout:{showId}` (static layout, no TTL, invalidated on seed/migration only) + `show:detail:{showId}` (5 min TTL). | Layout is fully static; show detail carries the dynamic `available_seats` count which can drift, so a short TTL is safer than manual invalidation on every booking. Invalidation helpers exposed as `invalidateShowLayout` / `invalidateShowDetail` for Phase 6+. |

## Known Issues / Tech Debt
- **Local port collision (dev machine only).** A native `postgresql-x64-18` Windows service
  owns port 5432, so `localhost:5432` bypasses the Docker container. Verification was run
  on `POSTGRES_PORT=55432` / `REDIS_PORT=56379`. Not a repo defect; README documents the
  override. Stop or reconfigure the native service to use the defaults.
- `pg` and Prisma coexist at the *source* level: the schema is Prisma, the runtime is `pg` until the dev environment has network. When Prisma is installed (`pnpm install` succeeds end-to-end), the Prisma client can be regenerated from `schema.prisma` without further refactoring; queries live in repository modules behind narrow interfaces.
- Node pinned to 22 vs 24 — revisit when standardizing the LTS line.
- Integration tests (incl. `/health`) require Docker running locally; CI provides Postgres + Redis service containers.

## Notes / Learnings
- Verified green on 2026-10-01: `pnpm lint`, `pnpm typecheck`, `pnpm test` (1 passing integration test against live pg+redis), `pnpm build`, and an end-to-end `node dist/index.js` → `GET /health` returning `200 {"status":"ok", ...}` with `reqId` in every log line.
- `pnpm` 10 blocks dependency build scripts by default; `esbuild` (via vitest/tsx) is allowlisted through `pnpm.onlyBuiltDependencies` in the root `package.json`.
- Fastify v5: pass a custom pino instance via `loggerInstance` (not `logger`); `requestIdLogLabel` is deprecated — default label is already `reqId`.
- Phase 1: the seat-status `BOOKED` view in `GET /shows/:id/seats` reads from `booking_seats` joined to `bookings` with `status IN ('PENDING','CONFIRMED')`. Redis `HELD` are merged in by Phase 3.
