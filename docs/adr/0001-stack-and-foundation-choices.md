# ADR 0001: Stack and foundation choices

- **Status:** Accepted
- **Phase:** 0 - Setup & Foundation
- **Date:** 2026-10-23

## Context

SeatRush must never double-book a seat while serving many simultaneous buyers. The PRD
fixes most of the stack (Next.js, Fastify, PostgreSQL, Redis, Socket.IO, BullMQ) and
`AGENTS.md` narrows the remaining options: Fastify over Express, Vitest over Jest, pnpm
workspaces, Node 22, ESM with NodeNext resolution.

What was still open for Phase 0 was the shape of the foundation itself: which exact
package versions to pin, how a single `GET /health` endpoint should prove the two
dependencies are reachable, how configuration and secrets are handled, and how the
toolchain stays fast without becoming loose. Those choices are invisible in the final
code but constrain every later phase, which is exactly what an ADR is for.

## Decision

### Monorepo and package layout

- pnpm workspaces (`pnpm-workspace.yaml`) with three packages: `apps/api`, `apps/web`,
  `packages/shared`.
- Package names are **unscoped** (`api`, `web`, `shared`) so the commands documented in
  `AGENTS.md` work literally: `pnpm --filter api test`.
- `packages/shared` is compiled to `dist` with `tsc` and consumed through its `exports`
  map. The root scripts (`dev`, `build`, `typecheck`, `test`) build `shared` first so
  downstream packages always typecheck against real `.d.ts` files.
- `docker-compose.yml` lives at the **repository root**, not in `infra/`, so the
  documented `docker compose up -d` works without a `-f` flag. `infra/` remains the
  home for Phase 9 k6 scripts.

### TypeScript

- TypeScript **5.9.3**, not the latest 7.0.2. `typescript-eslint@8` declares a peer range
  of `>=4.8.4 <6.1.0`, so pairing it with TS 7 produces an unsupported install and
  disables the lint rules the project depends on.
- `strict` plus `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns`,
  `noPropertyAccessFromIndexSignature` and `verbatimModuleSyntax`.
- ESM everywhere (`"type": "module"`), with `module` / `moduleResolution` set to
  `NodeNext`. Relative imports therefore carry an explicit `.js` extension, which is the
  file name Node actually runs.
- `apps/web` overrides `moduleResolution` to `Bundler` and enables `jsx: preserve`, as
  Next.js requires.

### Tooling

- **ESLint 10** flat config (`eslint.config.js`) using `typescript-eslint` without
  type-aware rules. Type-aware linting is slow, and its main value (catching wrong types)
  is already covered by `pnpm typecheck`. `no-explicit-any` stays an error, per
  `AGENTS.md`.
- **Prettier** owns formatting; `eslint-config-prettier` is applied last so the two tools
  never disagree.
- **Vitest 5** with the `node` environment. HTTP tests use Fastify's built-in
  `app.inject()` rather than adding Supertest: it is the framework's own request driver,
  so a second HTTP harness would be a dependency with no added coverage.

### API foundation

- **Fastify 5** with `loggerInstance` (v5 expects a ready-made pino instance rather than
  the old `logger` config shape). `genReqId: () => crypto.randomUUID()` together with
  `requestIdHeader: 'x-request-id'` means every request carries a traceable id that also
  appears as `reqId` in every pino line.
- **pino** writes newline-delimited JSON by default. Human-readable output is opt-in via
  `LOG_PRETTY` and defaults to on only in `NODE_ENV=development`, so CI and test output
  stay machine-readable.
- **`GET /health`** probes Postgres (`SELECT 1` via `pg`) and Redis (`PING` via
  `ioredis`) **concurrently**, returns `200` when both answer and `503` when either is
  down, and always returns a full body naming the failing dependency.
  - Postgres is reached with the thin `pg` driver for now. Prisma arrives in Phase 1;
    every module depends on the `Pool` type rather than a concrete client, so the swap
    stays inside `lib/postgres.ts`.
  - Each probe is wrapped in a timeout and never throws: a failed dependency is data to
    report, not an exception.
- Error responses share one envelope, `{ error: { code, message, requestId } }`, produced
  by a single `setErrorHandler`. Unexpected errors are logged in full but reported as a
  generic `INTERNAL_ERROR`, so internals never leak to clients.

### Configuration and secrets

- Environment variables are validated once at startup with **Zod** (`lib/env.ts`). A bad
  value fails fast with a message naming every offending variable.
- `parseConfig()` is a pure function over an env bag, which is why configuration is
  unit-testable without touching `process.env`.
- `apps/api/.env` is loaded with `dotenv` and is **git-ignored**; only
  `apps/api/.env.example` is committed. No real `.env` with credentials exists in the
  repository, and the docker-compose credentials are documented local-development
  defaults, overridable through a root `.env`.
- Error messages and log lines redact `postgres://` / `redis://` connection strings,
  because those embed passwords and `AGENTS.md` forbids secrets in logs.

### Redis client policy

- `lazyConnect: true`, so a Redis outage cannot stop the API from booting; `/health`
  reports the outage instead.
- A bounded `retryStrategy` (3 attempts, capped backoff) lets the client recover from a
  transient blip without spinning forever. The hold and lock policy in Phase 3 must
  revisit this and preserve invariant 9 (Redis down means fail closed).

## Consequences

**Good**

- Every phase has a runnable, testable base: `pnpm lint`, `pnpm typecheck`, `pnpm test`
  and `pnpm build` are one command each, and CI enforces all four.
- Integration tests run against real Postgres and Redis, so the health endpoint is proven
  to detect genuine outages rather than simulate them.
- Secrets stay out of git, and the validation layer turns a missing variable into a clear
  startup error instead of an obscure runtime crash.
- Because every failure funnels through one error handler and every probe is dependency-
  injected, later phases can add modules without inventing new conventions.

**Costs and accepted risks**

- `typescript-eslint` without type-aware rules is weaker than the type-checked preset. The
  trade is CI speed, and it can be revisited if lint escapes slip through.
- Pinned versions (TypeScript 5.9, ESLint 10, Next 16) need periodic bumps. Pinning is
  deliberate: this is a learning project, and a reproducible install matters more than
  always being on the newest release.
- Not using Supertest means HTTP tests depend on Fastify's `inject()` API. If a phase
  ever needs to test against a real socket, Supertest can be added then.
- `.js` extensions on relative imports are required by NodeNext and look unusual to
  TypeScript newcomers; the alternative (`moduleResolution: node`) hides runtime bugs.
