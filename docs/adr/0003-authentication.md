# ADR 0003: Authentication design (Phase 2)

- **Status:** Accepted
- **Phase:** 2
- **Date:** 2026-10-23

## Context

Phase 2 adds `POST /auth/register`, `/auth/login`, `/auth/refresh` and `/auth/logout`.
Every later phase (holds, checkout, bookings) runs behind an authenticated user, so the
token design and the refresh-token lifecycle are decided here, once. The constraints we
started from:

- Passwords must never be stored or logged in plaintext (`AGENTS.md`).
- The API is stateless behind Fastify, so authentication is JWT-based.
- A refresh token that leaks must be detectable and containable.
- The response envelope `{ error: { code, message, requestId } }` already exists and every
  new failure must use it.

## Decision

**1. Password hashing: Argon2id via `@node-rs/argon2`.**
OWASP-recommended parameters: `memoryCost = 19456` KiB (19 MiB), `timeCost = 2`,
`parallelism = 1`. Hashes are stored in `users.password_hash`. Login runs a verify
against a constant dummy hash when the email is unknown, so a missing account and a wrong
password take the same time and return the identical `INVALID_CREDENTIALS` 401 — the
endpoint cannot be used to enumerate registered emails.

**2. Tokens: two JWTs, two secrets.**
Access and refresh tokens are both HS256 JWTs signed with `jose`, but with **separate
secrets** (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`). A leaked refresh secret therefore
cannot mint an access token and vice versa. Access tokens are short-lived (default 15
min) and self-contained; refresh tokens are long-lived (default 7 days) and carry a
`tokenType: "refresh"` claim. Every token gets a random `jti` (UUID).

**3. Refresh-token storage: SHA-256 hash, unique, in Postgres.**
`sessions.refresh_token_hash` stores `sha256(token)` as 64 hex chars, `UNIQUE`. The raw
token exists only in the client's HttpOnly cookie. A plain SHA-256 (not Argon2) is the
right tool here: the input is already a high-entropy signed JWT, so there is nothing to
brute-force, and the lookup must be a fast indexed equality check.

**4. Rotation and reuse detection.**
`POST /auth/refresh` is single-use:

- verify signature → look up the session by hash → revoke it → issue a new pair;
- if the presented token belongs to an **already-revoked** session, it is being replayed,
  so **every active session for that user is revoked** (`UPDATE ... WHERE revoked_at IS
NULL`) and the request fails with 401. The legitimate user is logged out and must log
  in again; that is the intended containment for a stolen token.

**5. Cookie policy** (`REFRESH_COOKIE_NAME = "seatrush_refresh"`):
`HttpOnly`, `SameSite=Strict`, `Path=/auth`, `Max-Age` = refresh TTL, and `Secure`
derived from `NODE_ENV` (on in production, overridable with `COOKIE_SECURE`). The refresh
token is never placed in a JSON response body; only the access token is.

**6. Rate limiting.** `@fastify/rate-limit`, keyed by IP, applied per auth route via
`config.rateLimit`, tuned by `AUTH_RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_WINDOW_MS`
(default 20 / 60 s). Rejections use the standard envelope with code `RATE_LIMITED` and
HTTP 429.

**7. Reusable middleware.** `app.requireAuth` (a Fastify `preHandler`) verifies the
`Authorization: Bearer` access token and attaches `request.currentUser`. Phase 3+ adds it
to protected routes with a single option instead of re-implementing token parsing.

**8. Duplicate email.** `users.email` is a **plain** unique index (`users_email_key`,
verified in `schema.prisma` and the init migration — it is _not_ partial). Prisma
`P2002` on `users` therefore means only one thing, and is mapped to HTTP 409
`EMAIL_ALREADY_EXISTS`.

## Consequences

- Easier: a leaked refresh token is single-use and its replay is detected and contained;
  the database never holds a usable refresh token; password compromise is bounded by
  Argon2id cost.
- Harder: a `sessions` table and rotation logic must be maintained; every future phase
  that authenticates must use `app.requireAuth` rather than reading cookies.
- Accepted risk: Argon2id at 19 MiB is tuned for this project's scale, not for a large
  multi-tenant deployment; parameters are centralised in `password.ts` if they need to
  rise. Logout only clears the cookie (no server-side revoke) — reuse detection already
  kills stolen tokens, and the PRD has no explicit logout requirement in this phase.
