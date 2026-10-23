import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../../src/app.js';
import type { SeatrushFastifyInstance } from '../../../src/lib/logger.js';
import { createRedisClient } from '../../../src/lib/redis.js';
import type { AuthResponse } from 'shared';
import {
  assertInfrastructureReady,
  closeQuietly,
  testConfig,
  testPrisma,
} from '../../helpers/test-app.js';

/**
 * Proves the reusable requireAuth middleware works today, using a tiny throwaway
 * protected route. Phase 3 and 6 reuse the exact same preHandler.
 */
describe('requireAuth middleware', () => {
  const config = testConfig({ AUTH_RATE_LIMIT_MAX: '1000' });
  let app: SeatrushFastifyInstance;
  let prisma: PrismaClient;
  let redis: Redis;
  const email = 'middleware.user@test.local';
  let accessToken: string;

  // A protected route that does not exist yet in the product, mounted only here.
  const probeRoute: FastifyPluginAsync = async (fastify) => {
    fastify.get('/test/protected', { preHandler: fastify.requireAuth }, async (request) => ({
      userId: request.currentUser?.userId ?? 'missing',
      email: request.currentUser?.email ?? 'missing',
    }));
  };

  beforeAll(async () => {
    await assertInfrastructureReady(config);
    prisma = testPrisma(config);
    redis = createRedisClient(config);
    app = buildServer({ config, prisma, redis });
    await app.register(probeRoute);
    await app.ready();

    await prisma.session.deleteMany({ where: { user: { email } } });
    await prisma.user.deleteMany({ where: { email } });
    const registered = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: 'correct horse battery', displayName: 'Middleware' },
    });
    accessToken = registered.json<AuthResponse>().accessToken;
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { user: { email } } });
    await prisma.user.deleteMany({ where: { email } });
    await app?.close();
    await closeQuietly(redis);
    await closeQuietly(prisma);
  });

  it('passes a valid bearer token and exposes the caller on the request', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ email: string }>().email).toBe(email);
  });

  it('rejects a request with no Authorization header', async () => {
    const response = await app.inject({ method: 'GET', url: '/test/protected' });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a malformed or garbage bearer token', async () => {
    for (const header of ['Bearer', 'Bearer ', 'Bearer not.a.jwt', 'Basic abc123']) {
      const response = await app.inject({
        method: 'GET',
        url: '/test/protected',
        headers: { authorization: header },
      });
      expect(response.statusCode).toBe(401);
    }
  });

  it('rejects a token signed with a DIFFERENT secret', async () => {
    // Forge a structurally valid token with an ATTACKER's signing key and present
    // it to the real app: signature verification must reject it.
    const { SignJWT } = await import('jose');
    const forged = await new SignJWT({ email })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject('11111111-1111-4111-8111-111111111111')
      .setJti('forged-token')
      .setIssuer(config.jwt.issuer)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('an-attacker-controlled-secret-0000000000000'));

    const response = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects an EXPIRED access token', async () => {
    // A 60s minimum TTL keeps the test fast: mint a token that is already expired
    // by signing directly with the same secret rather than waiting.
    const { SignJWT } = await import('jose');
    const expired = await new SignJWT({ email })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject('11111111-1111-4111-8111-111111111111')
      .setIssuer(config.jwt.issuer)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(new TextEncoder().encode(config.jwt.accessSecret));

    const response = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: { authorization: `Bearer ${expired}` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { message: string } }>().error.message).toContain('expired');
  });
});
