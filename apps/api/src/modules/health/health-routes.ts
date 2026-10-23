import type { PrismaClient } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';
import type { Redis } from 'ioredis';
import { HEALTH_STATUS } from 'shared';
import { buildHealthReport } from './health-service.js';

export interface HealthRoutesOptions {
  prisma: PrismaClient;
  redis: Redis;
  serviceName: string;
  probeTimeoutMs: number;
  /** Epoch milliseconds captured when the server was created. */
  startedAt: number;
}

/**
 * `GET /health` - liveness plus dependency readiness in a single endpoint.
 *
 * 200 = process is up and both dependencies answered.
 * 503 = process is up but at least one dependency is unreachable, which is what
 *      load balancers and `docker compose` health checks key off.
 */
export const healthRoutes: FastifyPluginAsync<HealthRoutesOptions> = async (fastify, options) => {
  fastify.get('/health', async (_request, reply) => {
    const report = await buildHealthReport(
      { prisma: options.prisma, redis: options.redis },
      { serviceName: options.serviceName, probeTimeoutMs: options.probeTimeoutMs },
      Math.round((Date.now() - options.startedAt) / 1000),
    );

    const statusCode = report.status === HEALTH_STATUS.OK ? 200 : 503;
    return reply.code(statusCode).header('cache-control', 'no-store').send(report);
  });
};
