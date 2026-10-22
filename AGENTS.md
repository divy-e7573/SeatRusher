# AGENTS.md

Instructions for AI coding agents (Claude Code, etc.) working on this repo. Read this at the start of every session.

## Project in one line

A real-time ticketing system (BookMyShow-style) that never double-books under high concurrency. Full spec: `PRD.md`. Progress: `TRACKER.md`.

## Workflow rules (MUST follow)

1. **Session start:** Read `PRD.md`, `AGENTS.md`, and `TRACKER.md`. Identify the current phase from the tracker.
2. **One phase at a time.** Do not work on the next phase until the current phase's Definition of Done is met.
3. **Small steps:** For larger work, present a plan (files, approach) first, then implement.
4. **Session end / task complete:** Update `TRACKER.md` (checkboxes, decisions, known issues).
5. **Ask questions** when a requirement is ambiguous. Do not guess on major design decisions.
6. Record significant design decisions in `docs/adr/NNNN-title.md` (short: context, decision, consequences).
7. Do not add anything outside the PRD's scope or non-goals without asking.

## Tech stack

Next.js (App Router) + TypeScript, Node.js + Fastify + Socket.IO, PostgreSQL + Prisma, Redis (ioredis + Lua), BullMQ, Vitest, Supertest, k6, Docker Compose, pnpm workspaces.

## Repo structure

```
apps/
  api/          # Fastify + Socket.IO backend
    src/
      modules/  # auth, shows, holds, bookings, payments (feature-based)
      lib/      # redis, prisma, queue, logger, config
      sockets/  # socket.io gateway
      jobs/     # BullMQ workers, reconciler
  web/          # Next.js frontend
packages/
  shared/       # zod schemas, shared types, event names/constants
infra/          # docker-compose, k6 scripts
docs/adr/       # architecture decision records
```

## Commands

```bash
pnpm install
docker compose up -d            # postgres + redis
pnpm --filter api dev
pnpm --filter web dev
pnpm --filter api test          # unit + integration
pnpm --filter api test:concurrency
pnpm lint && pnpm typecheck
pnpm prisma migrate dev         # from apps/api
k6 run infra/k6/<script>.js
```

(If a command does not exist yet, set it up first and note it in TRACKER.)

## Architecture invariants (NEVER break these)

1. **Postgres is the final source of truth.** Redis is only a fast, temporary hold layer. Always verify inside a Postgres transaction before confirming a booking.
2. The **partial unique index** on `booking_seats (show_id, seat_id)` (active bookings) must always exist. Removing or bypassing it is not allowed.
3. **Redis locks must be atomic:** `SET NX EX` or a Lua script. Never `GET` then `SET` (check-then-act).
4. **Multi-seat holds are all-or-nothing**, implemented in a Lua script.
5. **Only the owner can release/extend:** use compare-and-delete Lua, never a bare `DEL`.
6. **Redis keyspace notifications must not be the sole expiry mechanism.** Keep both a BullMQ delayed job and a sweeper reconciler.
7. **Use server time only** (`expires_at` comes from the server). Never trust the client clock.
8. **Webhooks must be idempotent** (unique event id in `processed_webhooks`).
9. **Redis down = fail closed:** reject new holds, never silently allow them.
10. When confirming a booking, use `SELECT ... FOR UPDATE` (or equivalent locking), and choose the transaction isolation level explicitly and document it in an ADR.

## Code conventions

- TypeScript strict mode. Avoid `any`.
- Validate input with **zod**; put schemas in `packages/shared` when both frontend and backend use them.
- Feature-based modules with `routes -> service -> repository` layers. No business logic in routes.
- Errors: custom error classes and a consistent JSON shape `{ error: { code, message } }`. Seat conflict = HTTP 409.
- Logging: `pino`, structured, with a `requestId` on every request. Never log secrets or tokens.
- Config: environment variables validated with zod; maintain `.env.example`. Never commit secrets.
- Redis key naming: `hold:{showId}:{seatId}`, `hold_meta:{holdId}`, `user_holds:{userId}:{showId}`. Define constants in one place.
- Use socket event names from `packages/shared` constants; do not hardcode strings.
- Naming: files `kebab-case`, types/classes `PascalCase`, variables `camelCase`, DB columns `snake_case`.

## Testing rules

- Write tests together with each new module, not afterwards.
- **Concurrency tests are mandatory** for hold and booking logic (N parallel attempts via `Promise.all`, assert exactly 1 success).
- Integration tests run against real Postgres + Redis (docker), not mocks, wherever locking or transactions are involved.
- Separate test cases for the failure scenarios in PRD FR-7.
- Before any PR/commit: `pnpm lint && pnpm typecheck && pnpm test` must pass.

## Git conventions

- One branch per phase: `phase/N-short-name`.
- Conventional commits: `feat:`, `fix:`, `test:`, `docs:`, `chore:`, `refactor:`.
- Small, focused commits. Never edit existing migration files; create a new migration.

## Definition of Done (per phase)

- [ ] All phase tasks checked in TRACKER
- [ ] Tests written and passing
- [ ] Lint + typecheck clean
- [ ] Required ADR / README updates done
- [ ] TRACKER.md updated (decisions, known issues)
- [ ] App runs via `docker compose up`

## Do NOT

- Treat Redis as the final source of truth.
- Use check-then-act patterns (race conditions).
- Skip tests or commit `.only`.
- Add heavy new dependencies without asking.
- Refactor unrelated files unless required by the task.
- Put real payment credentials or secrets in the repo.
