import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import type { Redis } from 'ioredis';
import type { AppConfig } from './lib/env.js';
import { registerErrorHandlers } from './lib/error-handler.js';
import { RateLimitError } from './lib/errors.js';
import { createLogger, SERVICE_NAME, type SeatrushFastifyInstance } from './lib/logger.js';
import { createAuthRepository } from './modules/auth/auth-repository.js';
import { createRequireAuth } from './modules/auth/auth-middleware.js';
import { authRoutes } from './modules/auth/auth-routes.js';
import { createAuthService } from './modules/auth/auth-service.js';
import { createTokenIssuer } from './modules/auth/tokens.js';
import { createHoldPreconditionsRepository } from './modules/holds/hold-preconditions-repository.js';
import { createHoldsRepository } from './modules/holds/holds-repository.js';
import { holdsRoutes } from './modules/holds/holds-routes.js';
import { createHoldsService } from './modules/holds/holds-service.js';
import { healthRoutes } from './modules/health/health-routes.js';
import { createShowCache } from './modules/shows/shows-cache.js';
import { createShowsRepository } from './modules/shows/shows-repository.js';
import { showsRoutes } from './modules/shows/shows-routes.js';
import { createShowsService } from './modules/shows/shows-service.js';
import { MAX_SEATS_PER_HOLD } from 'shared';

export interface BuildServerOptions {
  config: AppConfig;
  prisma: PrismaClient;
  redis: Redis;
}

/**
 * Assembles the Fastify instance without binding a port.
 *
 * Separating construction from `listen()` is what lets tests drive real HTTP
 * requests through the app with `app.inject()` without occupying a port.
 */
export function buildServer({
  config,
  prisma,
  redis,
}: BuildServerOptions): SeatrushFastifyInstance {
  const startedAt = Date.now();

  const app = Fastify({
    // loggerInstance (not logger) is the Fastify v5 way to pass a ready-made pino logger.
    loggerInstance: createLogger(config),
    // Every request gets a UUID, and an inbound x-request-id is honoured so a trace
    // survives across services. pino emits it as `reqId` on every request log line.
    genReqId: () => randomUUID(),
    requestIdHeader: 'x-request-id',
  });

  // Cookie support must be registered before the auth routes that read/write it.
  void app.register(cookie);

  // Brute-force protection. The global default is generous; the auth routes below
  // apply their own, much stricter, limit per route from validated env vars.
  void app.register(rateLimit, {
    global: false,
    // Keyed by IP so one abusive client cannot lock out everyone else.
    keyGenerator: (request) => request.ip,
    // Must return an Error (not a plain object) so Fastify reads `statusCode`
    // from it and our error handler emits the standard envelope with HTTP 429.
    errorResponseBuilder: (_request, context) => new RateLimitError(context.after),
  });

  // Fastify reads an inbound request id but does not echo one back, so add it
  // explicitly. A user reporting a failed request can quote this header, which
  // matches the `reqId` field in the structured logs and in every error envelope.
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  registerErrorHandlers(app);

  const tokens = createTokenIssuer(config.jwt);
  const authService = createAuthService({
    repository: createAuthRepository(prisma),
    tokens,
    logger: app.log,
  });

  // Decorated BEFORE any route that uses it: a Fastify decoration must exist
  // by the time a route referencing it is registered.
  app.decorate('requireAuth', createRequireAuth(tokens, authService));

  app.register(healthRoutes, {
    prisma,
    redis,
    serviceName: SERVICE_NAME,
    probeTimeoutMs: config.healthCheckTimeoutMs,
    startedAt,
  });

  // One hold store feeds both the write path (holds routes) and the read path
  // (seat map), so a hold is visible to the very next seat-map request.
  const holdsRepository = createHoldsRepository(redis);

  const showsRepository = createShowsRepository(prisma);
  const showsCache = createShowCache(redis, app.log);
  const showsService = createShowsService({
    repository: showsRepository,
    cache: showsCache,
    holds: holdsRepository,
  });
  app.register(showsRoutes, { service: showsService });

  app.register(authRoutes, { service: authService, config });

  app.register(holdsRoutes, {
    service: createHoldsService({
      holds: holdsRepository,
      preconditions: createHoldPreconditionsRepository(prisma),
      ttlSeconds: config.hold.ttlSeconds,
      maxSeats: MAX_SEATS_PER_HOLD,
      logger: app.log,
    }),
    rateLimit: config.hold.rateLimit,
  });

  return app;
}
