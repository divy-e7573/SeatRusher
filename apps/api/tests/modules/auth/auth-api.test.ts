import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../../src/app.js';
import type { SeatrushFastifyInstance } from '../../../src/lib/logger.js';
import { createRedisClient } from '../../../src/lib/redis.js';
import { REFRESH_COOKIE_NAME } from '../../../src/modules/auth/cookie.js';
import type { AuthResponse } from 'shared';
import {
  assertInfrastructureReady,
  closeQuietly,
  testConfig,
  testPrisma,
} from '../../helpers/test-app.js';

/**
 * Auth endpoint integration tests. Every one runs against real PostgreSQL, because
 * the properties under test (unique email, session rotation) are DATABASE facts.
 */
describe('auth endpoints', () => {
  // A generous rate limit so these tests cannot trip it accidentally. The limit
  // itself is proven separately in the rate-limiting test below.
  const config = testConfig({ AUTH_RATE_LIMIT_MAX: '1000' });
  let app: SeatrushFastifyInstance;
  let prisma: PrismaClient;
  let redis: Redis;

  const email = 'phase2.user@test.local';

  beforeAll(async () => {
    await assertInfrastructureReady(config);
    prisma = testPrisma(config);
    redis = createRedisClient(config);
    app = buildServer({ config, prisma, redis });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await closeQuietly(redis);
    await closeQuietly(prisma);
  });

  beforeEach(async () => {
    // Start from a clean slate so registration tests are deterministic.
    await prisma.session.deleteMany({ where: { user: { email } } });
    await prisma.user.deleteMany({ where: { email } });
  });

  const register = (overrides: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: 'correct horse battery', displayName: 'Phase Two', ...overrides },
    });

  it('registers a user, returns 201, an access token and sets an HttpOnly cookie', async () => {
    const response = await register();
    expect(response.statusCode).toBe(201);

    const body = response.json<AuthResponse>();
    expect(body.user.email).toBe(email);
    expect(body.user.displayName).toBe('Phase Two');
    expect(body.accessToken.split('.')).toHaveLength(3);
    expect(body.expiresInSeconds).toBe(900);

    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toContain(`${REFRESH_COOKIE_NAME}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/auth');
  });

  it('never returns the password hash in any response', async () => {
    const response = await register();
    const raw = response.body;
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain('password_hash');
    expect(raw).not.toContain('$argon2');
    expect(raw).not.toContain('correct horse battery');
  });

  it('stores an Argon2id hash, never the plaintext password', async () => {
    await register();
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });

    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user.passwordHash).not.toBe('correct horse battery');
  });

  it('normalises the email to lowercase so casing cannot create two accounts', async () => {
    await register({ email: 'Phase2.User@Test.LOCAL' });
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.email).toBe(email);
  });

  it('rejects a duplicate email with 409 EMAIL_ALREADY_EXISTS', async () => {
    expect((await register()).statusCode).toBe(201);

    const second = await register({ displayName: 'Impostor' });
    expect(second.statusCode).toBe(409);
    const body = second.json<{ error: { code: string; requestId: string } }>();
    expect(body.error.code).toBe('EMAIL_ALREADY_EXISTS');
    expect(body.error.requestId).toBeTruthy();
    expect(await prisma.user.count({ where: { email } })).toBe(1);
  });

  it('rejects invalid bodies with 400 BAD_REQUEST', async () => {
    const payloads = [
      { email: 'not-an-email', password: 'correct horse battery', displayName: 'X' },
      { email, password: 'short', displayName: 'X' },
      { email, password: 'correct horse battery', displayName: '' },
    ];
    for (const payload of payloads) {
      const response = await app.inject({ method: 'POST', url: '/auth/register', payload });
      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('BAD_REQUEST');
    }
  });

  it('logs in with correct credentials and rejects a wrong password with 401', async () => {
    await register();

    const ok = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'correct horse battery' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<AuthResponse>().user.email).toBe(email);

    const bad = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'wrong password entirely' },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json<{ error: { code: string } }>().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('returns the SAME error for an unknown email as for a wrong password', async () => {
    await register();
    const unknown = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'nobody@test.local', password: 'correct horse battery' },
    });
    const wrong = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'not the password' },
    });

    // Otherwise the endpoint becomes an account-enumeration oracle. Only the code
    // and message are compared: requestId is unique per request BY DESIGN, so two
    // responses can never share it.
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json<{ error: { code: string } }>().error.code).toBe('INVALID_CREDENTIALS');
    const unknownError = unknown.json<{ error: { code: string; message: string } }>().error;
    const wrongError = wrong.json<{ error: { code: string; message: string } }>().error;
    expect(wrongError.code).toBe(unknownError.code);
    expect(wrongError.message).toBe(unknownError.message);
  });

  it('stores only a SHA-256 hash of the refresh token, never the token itself', async () => {
    const response = await register();
    const cookie = String(response.headers['set-cookie']);
    const token = /seatrush_refresh=([^;]+)/.exec(cookie)?.[1];
    expect(token).toBeTruthy();

    const session = await prisma.session.findFirstOrThrow({ where: { user: { email } } });
    expect(session.refreshTokenHash).not.toBe(token);
    expect(session.refreshTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(session)).not.toContain(token ?? 'n/a');
  });
});
