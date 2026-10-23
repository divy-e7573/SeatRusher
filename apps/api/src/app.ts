import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { Redis } from 'ioredis';
import type { AppConfig } from './lib/env.js';
import { registerErrorHandlers } from './lib/error-handler.js';
import { createLogger, SERVICE_NAME, type SeatrushFastifyInstance } from './lib/logger.js';
import { healthRoutes } from './modules/health/health-routes.js';
import { createShowCache } from './modules/shows/shows-cache.js';
import { createShowsRepository } from './modules/shows/shows-repository.js';
import { showsRoutes } from './modules/shows/shows-routes.js';
import { createShowsService } from './modules/shows/shows-service.js';

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

  // Fastify reads an inbound request id but does not echo one back, so add it
  // explicitly. A user reporting a failed request can quote this header, which
  // matches the `reqId` field in the structured logs and in every error envelope.
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  registerErrorHandlers(app);

  app.register(healthRoutes, {
    prisma,
    redis,
    serviceName: SERVICE_NAME,
    probeTimeoutMs: config.healthCheckTimeoutMs,
    startedAt,
  });

  const showsRepository = createShowsRepository(prisma);
  const showsCache = createShowCache(redis, app.log);
  const showsService = createShowsService({ repository: showsRepository, cache: showsCache });
  app.register(showsRoutes, { service: showsService });

  return app;
}
