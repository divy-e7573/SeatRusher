# SeatRush

A high-concurrency, real-time ticket booking system (BookMyShow-style) built so that
**no seat is ever sold twice**, even when thousands of users race for the same seat.

This repository is currently at **Phase 0 - Setup & Foundation**. There is no product
feature yet: the goal of this phase is a clean, runnable, tested foundation that later
phases can build on. See [TRACKER.md](TRACKER.md) for progress and
[docs/adr/](docs/adr/) for design decisions.

---

## Architecture at a glance

```text
                    browser
                      |
        +-------------+-------------+
        |                           |
   apps/web (Next.js)          apps/api (Fastify)
   port 3000                   port 4000
                                    |
                    +---------------+---------------+
                    |                               |
             PostgreSQL 16                   Redis 7
             (source of truth)         (fast hold layer)
                    ^                               ^
                    +-------- docker compose -------+
```

The long-term target is a two-layer design: **Redis holds seats temporarily with a TTL,
PostgreSQL is the final source of truth.** Only Phase 0 exists today.

---

## Prerequisites

| Tool                           | Version             | Notes                                                                        |
| ------------------------------ | ------------------- | ---------------------------------------------------------------------------- |
| Node.js                        | **22 LTS** or newer | Pinned in `.nvmrc`. `nvm use` reads it automatically.                        |
| pnpm                           | **10** or newer     | `npm install -g pnpm`. The exact version used is pinned in `packageManager`. |
| Docker Desktop / Docker Engine | Any recent version  | Needed for PostgreSQL and Redis.                                             |
| Git                            | Any recent version  | Only for cloning and committing.                                             |

You do **not** need a globally installed PostgreSQL or Redis: both run in containers.

---

## Setup

```bash
git clone <your-repo-url> seatrush
cd seatrush
pnpm install
```

Then create your local API environment file (it is git-ignored and must never be
committed):

```bash
# macOS / Linux
cp apps/api/.env.example apps/api/.env

# Windows PowerShell
Copy-Item apps/api/.env.example apps/api/.env
```

The example file already points at the default local credentials, so no edit is needed
unless you changed the docker-compose defaults.

---

## Starting the infrastructure

```bash
docker compose up -d          # start Postgres + Redis
docker compose ps             # both should show "healthy"
docker compose down           # stop (named volumes keep your data)
docker compose down -v        # stop and delete the data volumes
```

`docker compose.yml` defines **only** the infrastructure. The API and web app run on
your host so that hot reload stays instant.

### Port conflicts

The defaults are `5432` (Postgres) and `6379` (Redis). If something already occupies
either port - a native PostgreSQL service is a common one on Windows and macOS - change
the host ports in a root `.env` file, which docker compose reads automatically:

```bash
POSTGRES_PORT=55432
REDIS_PORT=56379
```

Then point `DATABASE_URL` and `REDIS_URL` in `apps/api/.env` at the same ports:

```dotenv
DATABASE_URL=postgres://seatrush:seatrush_dev_password@localhost:55432/seatrush
REDIS_URL=redis://localhost:56379
```

---

## Environment configuration

| Variable                  | Default       | Purpose                                                             |
| ------------------------- | ------------- | ------------------------------------------------------------------- |
| `NODE_ENV`                | `development` | `development`, `test` or `production`.                              |
| `HOST`                    | `0.0.0.0`     | Interface the API binds to.                                         |
| `PORT`                    | `4000`        | API port.                                                           |
| `LOG_LEVEL`               | `info`        | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`.       |
| `LOG_PRETTY`              | auto          | `true` for human-readable logs. Defaults to on in development only. |
| `DATABASE_URL`            | _(required)_  | PostgreSQL connection string.                                       |
| `REDIS_URL`               | _(required)_  | Redis connection string.                                            |
| `HEALTH_CHECK_TIMEOUT_MS` | `2000`        | Per-dependency health probe timeout.                                |

Every variable is validated with Zod at startup. A missing or malformed value stops the
process immediately and prints exactly which variables are wrong:

```text
Invalid environment configuration:
  - DATABASE_URL: must be a connection string using one of: postgres:, postgresql:
```

**Secrets:** only `apps/api/.env.example` is committed. `apps/api/.env` and a root
`.env` are git-ignored. The credentials in `docker-compose.yml` are well-known local
development defaults, not secrets - override them for anything non-local. Connection
strings are redacted from log lines and error messages.

---

## Development commands

Run these from the repository root:

| Command                             | What it does                                                     |
| ----------------------------------- | ---------------------------------------------------------------- |
| `pnpm install`                      | Install all workspace dependencies.                              |
| `pnpm dev`                          | Build `shared`, then run the API (4000) and web (3000) together. |
| `pnpm --filter api dev`             | Run only the API with hot reload.                                |
| `pnpm --filter web dev`             | Run only the web app with hot reload.                            |
| `pnpm lint`                         | ESLint over the whole workspace.                                 |
| `pnpm typecheck`                    | TypeScript in strict mode for every package.                     |
| `pnpm test`                         | Build `shared`, then run every package's tests.                  |
| `pnpm --filter api test`            | API tests only (includes integration tests).                     |
| `pnpm build`                        | Build `shared`, `api` and `web` for production.                  |
| `pnpm format` / `pnpm format:check` | Apply or verify Prettier formatting.                             |

On Windows, use `pnpm.cmd` instead of `pnpm` if PowerShell blocks the `.ps1` shim.

---

## Verifying the setup

Run these in order for a full check:

```bash
docker compose config --quiet   # 1. compose file is valid
docker compose up -d --wait     # 2. both services report healthy
docker compose ps                # 3. confirm "healthy"

pnpm lint                        # 4. lint
pnpm typecheck                   # 5. strict typecheck
pnpm test                        # 6. unit + integration tests
pnpm build                       # 7. production build
```

### Confirming the API is healthy

With the API running (`pnpm --filter api dev`) and the containers up:

```bash
curl http://localhost:4000/health
```

```json
{
  "status": "ok",
  "service": "seatrush-api",
  "uptimeSeconds": 12,
  "timestamp": "2026-10-23T04:15:22.101Z",
  "checks": {
    "postgres": { "status": "up", "latencyMs": 3 },
    "redis": { "status": "up", "latencyMs": 1 }
  }
}
```

`status` is `ok` with **HTTP 200** only when both dependencies answer. If either is down
you get **HTTP 503** and `status: "degraded"`, and the body names the failing dependency.
Every response carries an `x-request-id` header; quote it when reporting a problem, and
grep for it in the API logs to find the exact request.

---

## How the API starts and checks health (beginner-friendly)

1. **You run `pnpm --filter api dev`.** That executes the `dev` script in
   `apps/api/package.json`, which runs the TypeScript file `src/index.ts` directly through
   `tsx` (a TypeScript runner). Nothing is compiled yet, so edits apply instantly.

2. **`src/index.ts` reads configuration.** It calls `loadConfig()`, which asks `dotenv`
   to read `apps/api/.env` into `process.env` (without overwriting variables you already
   set in your shell), then validates everything with Zod. If a value is wrong, the
   process prints the problem and exits - it never starts half-configured.

3. **A logger and two clients are created.** `createLogger()` builds a pino logger.
   `createPostgresPool()` creates a database connection pool and `createRedisClient()`
   creates a Redis client. The Redis client is created with `lazyConnect`, so it does
   **not** connect yet: a Redis outage cannot stop the API from booting.

4. **The HTTP server is assembled.** `buildServer()` creates the Fastify instance,
   attaches the error handlers, and registers the `/health` route. No port is opened yet.

5. **The port is opened.** `app.listen()` binds the port, and the server logs the
   address it is listening on.

6. **When you call `GET /health`, two probes run at the same time:**
   - Postgres: `SELECT 1` - the cheapest possible "are you alive?" query.
   - Redis: `PING`, which Redis answers with `PONG`.

   Because they run **in parallel**, the endpoint takes as long as the slower probe, not
   the sum of both. Each probe is wrapped in a timeout so a hung dependency cannot hang
   the endpoint, and a failing probe never throws - it returns a result saying "down",
   because the endpoint's job is to _report_ on both dependencies, not crash on one.

7. **The result becomes a response.** Both answers are combined: if both are `up` the
   server replies `200 {"status":"ok"}`; otherwise `503 {"status":"degraded"}` with the
   failing dependency named and its latency measured. The `timestamp` always comes from
   the server's clock, never the client's.

### Where to look when something breaks

- **API log lines** are one JSON object per line and always contain `reqId`.
- **Error responses** always look like `{ "error": { "code", "message", "requestId" } }`.
  Unexpected errors are logged in full but reported to the client as a generic
  `INTERNAL_ERROR`, so internals never leak.
- **Tests** live next to the code they cover: `apps/api/tests/`.

---

## Repository layout

```text
apps/
  api/                 Fastify backend
    src/
      index.ts         Entry point: config, clients, listen, shutdown
      app.ts           Builds the Fastify instance (no port binding)
      lib/             config (env), logger, postgres, redis, errors, timeout
      modules/health/  /health route + service (routes -> service pattern)
    tests/             Unit and integration tests
  web/                 Next.js frontend (App Router) - placeholder page only
packages/
  shared/              Types and constants shared by API and web
docs/
  adr/                 Architecture decision records
infra/                 Operational assets (k6 scripts arrive in Phase 9)
docker-compose.yml     PostgreSQL + Redis for local development
```

---

## Testing policy

Unit tests need nothing. Integration tests use **real** PostgreSQL and Redis containers,
never mocks, because the thing under test is connectivity itself. Start the containers
first:

```bash
docker compose up -d --wait
pnpm test
```

To point the tests at non-default hosts or ports:

```bash
TEST_DATABASE_URL=postgres://... TEST_REDIS_URL=redis://... pnpm test
```

---

## Contributing

- One branch per phase: `phase/N-short-name`.
- Conventional commits: `feat:`, `fix:`, `test:`, `docs:`, `chore:`, `refactor:`.
- Before opening a pull request: `pnpm lint && pnpm typecheck && pnpm test`.
- Record significant design decisions in `docs/adr/` and update `TRACKER.md`.

## License

Private learning project.
