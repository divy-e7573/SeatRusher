# TRACKER.md

Live progress tracker for SeatRush. Update this file after each task and at the end of every phase.

**Working mode:** Fresh restart from Phase 0. Implement and learn one phase at a time, using Codex for implementation and ChatGPT for review/explanation.
**Current phase:** Phase 2 — Authentication (implemented and locally verified; awaiting user review)
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
- [x] Prisma schema (`users`, `venues`, `screens`, `seats`, `shows`, `show_prices`, `bookings`, `booking_seats`, `payments`, `processed_webhooks`)
- [x] Partial unique index on `booking_seats (show_id, seat_id)` for active bookings — hand-written migration `20261023052232_partial_unique_booking_seats`
- [x] Migrations applied with `pnpm --filter api db:migrate` (Prisma CLI, no custom runner)
- [x] Seed script (`pnpm --filter api db:seed`): 1 venue, 1 screen with 150 seats (rows A-J, categories regular/premium), 3 shows; idempotent (verified by test)
- [x] `GET /shows`, `GET /shows/:id`, `GET /shows/:id/seats`
- [x] Layout cache in Redis (`seat:layout:{showId}` no TTL, `show:detail:{showId}` 300s TTL) with explicit invalidation helpers
- [x] Integration tests against real Postgres (isolated `seatrush_test` schema) and real Redis
- [x] DB-level test proving the partial unique index rejects duplicate active `(show_id, seat_id)` rows
- [x] ADR 0002 — schema + partial unique index rationale
- [x] Prisma client replaces the temporary `pg` pool from Phase 0 (Postgres access is now Prisma, as the PRD requires)

### Phase 1 verification record (2026-10-23)

| # | Check | Command | Result |
|---|---|---|---|
| 1 | Install + Prisma generate | `pnpm install` | **PASS** — prisma 6.19.3 engines downloaded; `prisma generate` runs on postinstall. |
| 2 | Schema valid | `prisma validate` | **PASS** — `schema at prisma\schema.prisma is valid`. |
| 3 | Migrations applied | `pnpm --filter api db:migrate` | **PASS** — `init` + `partial_unique_booking_seats`; database in sync; client generated. |
| 4 | Index present | `pg_indexes` query | **PASS** — `booking_seats_active_show_seat_key ... WHERE (status = ANY (ARRAY['PENDING','CONFIRMED']))`. |
| 5 | Seed (dev) | `pnpm --filter api db:seed` | **PASS** — venue=1, screen=1, seats=150, shows=3. |
| 6 | Test DB prepared | `pnpm --filter api db:test:prepare` | **PASS** — `seatrush_test` schema migrated + seeded (150 seats, 3 shows). |
| 7 | Tests | `pnpm --filter api test` | **PASS** — 8 files, 41 tests, 0 failures. |
| 8 | Lint | `pnpm lint` | **PASS** — exit 0. |
| 9 | Typecheck | `pnpm typecheck` | **PASS** — exit 0, all 3 packages. |
| 10 | Format | `pnpm format:check` | **PASS** — all files formatted. |
| 11 | Build | `pnpm build` | **PASS** — shared + api (`tsc`), web (`next build`). |
| 12 | Live API | `node dist/index.js` + curl | **PASS** — `/health` 200 ok; `/shows` returns 3 seeded shows; `/shows/:id` 200; `/shows/:id/seats` 200 with 150 seats; bad id → 400 BAD_REQUEST; unknown id → 404 NOT_FOUND. Redis TTLs confirmed: `show:detail:*` = 300 s, `seat:layout:*` = no expiry. |

Tests added in Phase 1 (all against real Postgres + Redis):

- `shows-api.test.ts` — list ordering, detail, seat layout counts/categories/prices,
  a booked seat flipping to BOOKED with availability 150→149, 404 unknown id, 400 malformed id.
- `shows-cache.test.ts` — 300 s TTL on show detail, no TTL on layout, cache serves stale
  value until `invalidateShow`, seat status stays live while layout is cached, `clearAllShowCaches` removes everything.
- `partial-unique-index.test.ts` — second active booking for the same seat fails with
  Prisma `P2002`; seat becomes bookable again after EXPIRED; same seat in two different
  shows is allowed; `P2002` is what the API maps to HTTP 409.
- `seed.test.ts` — seed run twice still leaves exactly 1 venue / 1 screen / 150 seats (15 per row A-J) / 3 shows.
- `redis-keys.test.ts` — key naming convention locked in.

#### Bugs found and fixed during Phase 1 (all caught by tests or live checks)

| Failure | Cause | Resolution |
|---|---|---|
| `prisma migrate dev` → `Schema engine error: undefined`; `db pull` → P1001 `Can't reach database server` | A native `postgresql-x64-18` service owns 5432, Docker's proxy also claims it — `localhost:5432` was ambiguous. Containers had also been recreated without the port env vars, so 55432 was no longer published. | Added a **root `.env`** (git-ignored) pinning `POSTGRES_PORT=55432` / `REDIS_PORT=56379` for docker compose, and pointed `apps/api/.env` at those ports. Plain `docker compose up -d` is now deterministic on this machine. |
| `pnpm --filter api db:test:prepare` → `ERR_MODULE_NOT_FOUND scripts/prepare-test-db.ts` | The file was never created: an earlier multi-file patch failed atomically and the add was silently dropped. | Created the file; verified the command completes. |
| Tests + live server: `Stream isn't writeable and enableOfflineQueue options is false` | With `lazyConnect`, any Redis command before the first `/health` probe fails — Phase 0 never issued a command outside the probe. | Added `ensureRedisConnected()` (memoised connect on first use) used by the cache module, the health probe and startup. Fixed a real production bug, not just a test issue. |
| `availableSeats` returned 149 → 1 | Bug in `shows-service`: passed the *booked* count instead of `total - booked`. | Fixed in `loadShowDetail` and `listShows`; the 150 → 149 test now proves it. |
| ESLint error in `seed.ts` (`Prisma` type-only import) + console warnings in CLI files | Import style rule; server logging rules don't apply to CLI entry points. | Split the type import; added an ESLint override allowing console in `prisma/*.ts` and `scripts/**` (their console is the CLI output). |

#### Phase 1 interpretation notes

- **Prisma version: 6.19.3, not `latest`.** `latest` is an 8.0 release candidate; Prisma 7
  requires Node `^22.18` (machine has 22.15) and switches to driver adapters, which
  contradicts the schema written in this phase. Rationale in ADR 0002.
- **`pg` was removed** now that Prisma owns database access (PRD: PostgreSQL + Prisma).
  The Phase 0 decision to use a `pg` pool for `/health` was explicitly deferred to this
  phase; it is now superseded.
- **Test database = isolated Postgres schema** (`seatrush_test`) on the same server, prepared
  by `pnpm --filter api db:test:prepare`. Constraint tests must write bookings; doing that in
  the dev schema would corrupt availability counts. Redis is shared but keys are namespaced.
- `show_prices` is a small table the Phase 1 brief did not list. Prices differ per category
  per show (regular vs premium), so the alternative was duplicating a price column on every
  seat. Flagged for review: happy to fold it back into `seats` if preferred.
- `GET /shows` is not cached (Phase 1 keeps it simple); caching the list is an easy Phase 6+ win.

## Phase 2: Authentication
- [x] `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh` (+ `POST /auth/logout` clears the cookie)
- [x] Password hashing with Argon2id (`@node-rs/argon2`, OWASP params); no plaintext or hash ever in a response or log
- [x] Short-lived JWT access token + long-lived refresh token, signed with **separate** secrets; refresh token stored only as a SHA-256 hash in a new `sessions` table (migration `20261023065913_sessions`)
- [x] Refresh-token rotation with reuse detection: replaying a revoked token revokes **all** active sessions for that user
- [x] HttpOnly refresh cookie (`SameSite=Strict`, `Secure` derived from `NODE_ENV`, `Path=/auth`)
- [x] Reusable `app.requireAuth` JWT middleware (preHandler) for Phase 3+ protected routes
- [x] Zod validation via shared schemas in `packages/shared`; duplicate email → Prisma `P2002` → HTTP 409 `EMAIL_ALREADY_EXISTS`
- [x] Per-route IP rate limiting (`@fastify/rate-limit`) returning HTTP 429 `RATE_LIMITED`
- [x] Tests against real PostgreSQL (64 tests, 12 files, all passing)
- [x] ADR 0003 — authentication decisions

### Phase 2 verification record (2026-10-23)

All commands below were actually executed on Windows / Node v22.15.0 / pnpm 10.33.0 /
Docker Desktop 29.5.3 (Postgres on 55432, Redis on 56379).

| # | Check | Command | Result |
|---|---|---|---|
| 1 | Email constraint verified | inspected `schema.prisma` + `init` migration + live `pg_indexes` | **PASS** — `users.email String @unique`, plain index `users_email_key` (NOT partial). |
| 2 | Dependencies installed | `pnpm add @node-rs/argon2 jose @fastify/cookie @fastify/rate-limit` (+ `zod` in shared) | **PASS** — argon2id hash/verify verified working on prebuilt Windows binaries. |
| 3 | Migration applied | `prisma migrate` (dev + `seatrush_test` via `db:test:prepare`) | **PASS** — `sessions` table, unique `refresh_token_hash`, FK cascade. |
| 4 | Tests | `pnpm --filter api test` | **PASS** — 12 files, 64 tests, 0 failures. |
| 5 | Lint | `pnpm lint` | **PASS** — exit 0. |
| 6 | Typecheck | `pnpm typecheck` | **PASS** — exit 0, all packages. |
| 7 | Format | `pnpm format:check` | **PASS** — all files match Prettier. |
| 8 | Build | `pnpm build` | **PASS** — shared + api (`tsc`), web (`next build`). |
| 9 | Live API | `node dist/index.js` + curl | **PASS** — see below. |

Live end-to-end against the compiled server (curl, real Postgres/Redis):

- `GET /health` → 200, postgres + redis up.
- `POST /auth/register` → 201; `Set-Cookie: seatrush_refresh=...; Max-Age=604800; Path=/auth; HttpOnly; SameSite=Strict`.
  Body contains `user` + `accessToken` only — no `passwordHash`, no refresh token.
- Duplicate register → 409 `{"error":{"code":"EMAIL_ALREADY_EXISTS",...}}`.
- Login with wrong password / unknown email → identical 401 `INVALID_CREDENTIALS`.
- Invalid body → 400 `BAD_REQUEST`.
- `POST /auth/refresh` → 200 with a **new** cookie; the old session row is revoked.
- Replaying the old (revoked) token → 401 `"Refresh token reuse detected; all sessions have
  been revoked"`, and the *new* token is then dead too (all active sessions revoked).
- `POST /auth/logout` → 204 with `Max-Age=0` clear-cookie.
- Database inspection: `password_hash` starts with `$argon2id$v=19$m=19456,t=2,p=1`;
  all `refresh_token_hash` values match `^[0-9a-f]{64}$` (SHA-256), none is a JWT.
- Log inspection: no JWT, password, or hash appears in any log line; auth logs record only
  email / userId / event.

Tests added in Phase 2 (against real PostgreSQL in the isolated `seatrush_test` schema):

- `auth-api.test.ts` — register 201 + cookie flags, no hash in response, Argon2id stored,
  email lowercased, duplicate 409, invalid bodies 400, login success, wrong password 401,
  unknown email identical to wrong password, refresh token stored only as a SHA-256 hash.
- `refresh-rotation.test.ts` — rotation (new token, old row revoked), old token rejected
  after rotation, reuse revokes ALL active sessions, expired token 401, tampered token 401,
  no cookie 401, logout clears cookie, access token cannot be used as a refresh token.
- `auth-middleware.test.ts` — valid bearer passes; missing/malformed header 401; token
  forged with an attacker secret 401; expired access token 401.
- `rate-limit.test.ts` — after `max` attempts the endpoint returns 429 with the standard
  `RATE_LIMITED` envelope and a `requestId`.

#### Bugs found and fixed during Phase 2 (caught by tests)

| Failure | Cause | Resolution |
|---|---|---|
| Register-then-login within the same second failed with a session-insert 409 | Two JWTs minted in the same second for the same user were **byte-identical** (same `sub`/`iat`/`issuer`), so their SHA-256 hashes collided on the unique `refresh_token_hash` index | Added a random `jti` (`randomUUID()`) to every issued token. Verified: register 201 then login 200 with distinct tokens. |
| Rate-limit test got HTTP 500 instead of 429 | `@fastify/rate-limit` **throws** whatever `errorResponseBuilder` returns; a plain object has no `statusCode`, so Fastify's error path treated it as an unexpected 500 | `errorResponseBuilder` now returns a `RateLimitError` (an `AppError` with status 429), which flows through the normal envelope. Test now asserts 429 + `RATE_LIMITED`. |
| ESLint: unused `name` arg in `secret()` helper; `z` imported as a value but used only as a type | Leftovers from an earlier revision | Removed the unused parameter; switched to `import type { z }`. |

#### Phase 2 interpretation notes

- **`users.email` is a plain unique index**, verified in the schema, the init migration and
  the live database. Prisma `P2002` on `users` can therefore only mean a duplicate email and
  is mapped to 409 `EMAIL_ALREADY_EXISTS` (Phase 1's `P2002` mapping still reserves
  `booking_seats` for `SEAT_CONFLICT`).
- **Logout is cookie-only** (no server-side session revoke). The Phase 2 brief did not list
  logout as a task and the PRD has no logout requirement; reuse detection already contains a
  stolen token. Recorded here so it is a conscious choice, not an oversight.
- **Argon2id over bcrypt** (the brief allowed either): Argon2id is the current OWASP first
  choice and `@node-rs/argon2` ships prebuilt Windows binaries, so no native build toolchain
  is required.
- **The refresh token never appears in a JSON body**, only in the HttpOnly cookie; the
  access token is the only token in the body. The `AuthResponse` type enforces this.
- **No new dependencies beyond auth necessity**: `@node-rs/argon2`, `jose`,
  `@fastify/cookie`, `@fastify/rate-limit` (API) and `zod` (shared). No Supertest, no
  cookie-parser (the Fastify plugin covers it), no frontend auth.

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
| 2026-10-23 | Argon2id (`@node-rs/argon2`, m=19456,t=2,p=1) for password hashing; JWT access + refresh signed with **separate** secrets; refresh token stored only as a SHA-256 hash in a new `sessions` table; single-use rotation with reuse detection that revokes ALL active sessions for the user; HttpOnly/SameSite=Strict/Secure-in-prod cookie scoped to `/auth`; per-route IP rate limiting returning 429 `RATE_LIMITED`; reusable `app.requireAuth` preHandler. See ADR 0003. | Standard, defensible choices for a token-based API: Argon2id is OWASP's first recommendation and ships prebuilt Windows binaries; separate secrets stop a leaked refresh key from minting access tokens; a single-use refresh token makes theft detectable, and revoking every session on reuse contains it; the raw token lives only in the client's cookie. |
| 2026-10-23 | Prisma **6.19.3** replaces the Phase 0 `pg` pool for all database access. | PRD mandates Prisma; 6.x is the newest stable line that runs on Node 22.15 with `provider = postgresql` + `url`. Prisma 7 needs Node ^22.18 and driver adapters; `latest` is an 8.0 RC. |
| 2026-10-23 | Partial unique index `booking_seats_active_show_seat_key` created in a hand-written migration, covering `status IN ('PENDING','CONFIRMED')`. | Prisma cannot express a partial index. PENDING must occupy the seat or two concurrent checkouts would both insert and only one would fail after payment. See ADR 0002. |
| 2026-10-23 | Money stored as integer **paise** (`amount_paise`, `price_paise`, `total_amount_paise`). | Float money accumulates rounding errors; integer paise serialize cleanly to JSON. |
| 2026-10-23 | Added `show_prices` table (price per show per seat category). | Not in the original Phase 1 checklist; needed because premium vs regular pricing differs per show. Reviewable: could be folded back into `seats` if the reviewer prefers the shorter schema. |
| 2026-10-23 | Integration tests run in an isolated Postgres schema `seatrush_test`, prepared by `pnpm --filter api db:test:prepare`. | Constraint tests must write bookings; doing that in the dev schema would corrupt availability counts. Same engine and migrations, zero interference. |
| 2026-10-23 | Redis cache: `seat:layout:{showId}` no TTL (immutable layout), `show:detail:{showId}` 300 s TTL (contains drifting availability). Seat status never cached. | Split TTLs by how fast data changes; a cached seat map can never show a booked seat as available. See ADR 0002. |
| 2026-10-23 | Root `.env` (git-ignored) pins `POSTGRES_PORT=55432` / `REDIS_PORT=56379` on this machine. | Native `postgresql-x64-18` service owns 5432, and Docker's proxy also claims it, making `localhost:5432` ambiguous. A root `.env` makes plain `docker compose up -d` deterministic. |
| 2026-10-23 | Re-confirmed on the fresh restart: Fastify + Vitest, unscoped package names (`api`, `web`, `shared`), Node 22, NodeNext ESM with `.js` import extensions, ESLint `recommended` (no type-checked rules), env in `apps/api/.env` loaded by dotenv. | All still match the implementation and remain sound. The `/health` probe now uses Prisma instead of `pg` (superseded in Phase 1, see above). |
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
- **`booking_seats.status` is denormalized** from `bookings.status`. Phase 6 must update both
  in one transaction; convention + tests guard it for now, a repository helper is planned.
- **The partial unique index is invisible to `schema.prisma`** (Prisma has no WHERE clause on
  indexes). It lives only in the migration. Do not prune migrations by reading the schema.
- **`show_prices` was added beyond the Phase 1 checklist** (per-category pricing). Flagged for
  reviewer decision; can be folded into `seats` if the simpler schema is preferred.
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
