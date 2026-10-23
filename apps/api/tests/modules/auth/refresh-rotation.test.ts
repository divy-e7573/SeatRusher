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
 * Refresh-token rotation and reuse detection - the part of auth that protects a
 * stolen session. Run against real PostgreSQL because it is session rows, not
 * JavaScript, that make rotation safe.
 */
describe('refresh token rotation and reuse', () => {
  const config = testConfig({ AUTH_RATE_LIMIT_MAX: '1000' });
  let app: SeatrushFastifyInstance;
  let prisma: PrismaClient;
  let redis: Redis;
  const email = 'rotate.user@test.local';

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
    await prisma.session.deleteMany({ where: { user: { email } } });
    await prisma.user.deleteMany({ where: { email } });
  });

  async function register() {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: 'correct horse battery', displayName: 'Rotator' },
    });
    expect(response.statusCode).toBe(201);
    return cookieToken(response.headers['set-cookie']);
  }

  function cookieToken(setCookie: string | string[] | undefined): string {
    const raw = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie);
    const match = new RegExp(`${REFRESH_COOKIE_NAME}=([^;]+)`).exec(raw);
    expect(match?.[1]).toBeTruthy();
    return match?.[1] ?? '';
  }

  function cookieHeader(token: string): Record<string, string> {
    return { cookie: `${REFRESH_COOKIE_NAME}=${token}` };
  }

  it('rotates: a new token is issued and the old session row is revoked', async () => {
    const first = await register();
    const before = await prisma.session.count({ where: { user: { email }, revokedAt: null } });
    expect(before).toBe(1);

    const response = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: cookieHeader(first),
    });

    expect(response.statusCode).toBe(200);
    const second = cookieToken(response.headers['set-cookie']);
    expect(second).not.toBe(first);

    const sessions = await prisma.session.findMany({
      where: { user: { email } },
      orderBy: { createdAt: 'asc' },
    });
    expect(sessions).toHaveLength(2);
    // The presented token's row is dead; the freshly issued one is live.
    expect(sessions[0]?.revokedAt).not.toBeNull();
    expect(sessions[1]?.revokedAt).toBeNull();
  });

  it('rejects the OLD token after a rotation (single use)', async () => {
    const first = await register();
    await app.inject({ method: 'POST', url: '/auth/refresh', headers: cookieHeader(first) });

    const reuse = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: cookieHeader(first),
    });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json<{ error: { code: string } }>().error.code).toBe('UNAUTHORIZED');
  });

  it('on reuse, revokes EVERY active session for that user', async () => {
    const stolen = await register();
    // The legitimate user also refreshes, creating a second live session.
    await app.inject({ method: 'POST', url: '/auth/refresh', headers: cookieHeader(stolen) });
    const live = await prisma.session.count({ where: { user: { email }, revokedAt: null } });
    expect(live).toBe(1);

    // The thief replays the now-revoked token: the theft signal fires.
    const attack = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: cookieHeader(stolen),
    });
    expect(attack.statusCode).toBe(401);
    expect(attack.json<{ error: { message: string } }>().error.message).toContain('reuse');

    // Containment: even the legitimate rotated session is now dead.
    const stillActive = await prisma.session.count({ where: { user: { email }, revokedAt: null } });
    expect(stillActive).toBe(0);
  });

  it('rejects an expired refresh token', async () => {
    const token = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: 'correct horse battery', displayName: 'Rotator' },
    });
    const refresh = cookieToken(token.headers['set-cookie']);

    // Expire the session row directly, which is what an aged token looks like.
    await prisma.session.updateMany({
      where: { user: { email } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: cookieHeader(refresh),
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a tampered or unsigned refresh token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: cookieHeader('not.a.jwt'),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a refresh request with no cookie at all', async () => {
    const response = await app.inject({ method: 'POST', url: '/auth/refresh' });
    expect(response.statusCode).toBe(401);
  });

  it('logout clears the cookie', async () => {
    await register();
    const response = await app.inject({ method: 'POST', url: '/auth/logout' });
    expect(response.statusCode).toBe(204);
    expect(String(response.headers['set-cookie'])).toContain(`${REFRESH_COOKIE_NAME}=`);
  });

  it('an access token cannot be used as a refresh token (separate secrets)', async () => {
    const registered = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: 'correct horse battery', displayName: 'Rotator' },
    });
    const accessToken = registered.json<AuthResponse>().accessToken;

    // Signing secrets differ, so the refresh verifier must reject the access token.
    const response = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: cookieHeader(accessToken),
    });
    expect(response.statusCode).toBe(401);
  });
});
