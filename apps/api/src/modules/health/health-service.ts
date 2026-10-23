import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { DEPENDENCY_STATUS, HEALTH_STATUS, type HealthResponseBody } from 'shared';
import { probePostgres } from '../../lib/prisma.js';
import { probeRedis } from '../../lib/redis.js';

export interface HealthDependencies {
  prisma: PrismaClient;
  redis: Redis;
}

export interface HealthServiceOptions {
  serviceName: string;
  probeTimeoutMs: number;
}

/**
 * Probes every dependency and reduces the results to a single verdict.
 *
 * Both probes run concurrently, so the endpoint costs the slowest probe rather
 * than the sum of the two. `timestamp` is always generated on the server: a health
 * verdict must never depend on a client's clock.
 */
export async function buildHealthReport(
  dependencies: HealthDependencies,
  options: HealthServiceOptions,
  uptimeSeconds: number,
): Promise<HealthResponseBody> {
  const [postgres, redis] = await Promise.all([
    probePostgres(dependencies.prisma, options.probeTimeoutMs),
    probeRedis(dependencies.redis, options.probeTimeoutMs),
  ]);

  const healthy = postgres.status === DEPENDENCY_STATUS.UP && redis.status === DEPENDENCY_STATUS.UP;

  return {
    status: healthy ? HEALTH_STATUS.OK : HEALTH_STATUS.DEGRADED,
    service: options.serviceName,
    uptimeSeconds,
    timestamp: new Date().toISOString(),
    checks: { postgres, redis },
  };
}
