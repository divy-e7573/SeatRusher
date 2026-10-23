import { Prisma, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { DEPENDENCY_STATUS, type DependencyHealth } from 'shared';
import type { AppConfig } from './env.js';
import { safeErrorMessage } from './errors.js';
import { withTimeout } from './timeout.js';

/**
 * Creates the Prisma client used by every data-access module.
 *
 * Prisma connects lazily on first query, so constructing the client never blocks
 * startup and a database outage surfaces through /health instead of a crash.
 *
 * The URL is passed explicitly (rather than read from the environment inside
 * Prisma) so tests can point one process at an isolated database, and so the
 * validated config from `lib/env.ts` remains the single source of truth.
 */
export function createPrismaClient(config: AppConfig, logger: Logger): PrismaClient {
  const client = new PrismaClient({
    datasources: { db: { url: config.databaseUrl } },
    // Query logging is opt-in: it is invaluable when debugging N+1 reads and
    // useless noise in normal test runs, so it follows the configured log level.
    log: config.logLevel === 'debug' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });

  // Route Prisma's diagnostics into pino so every line shares one JSON format.
  client.$on('warn' as never, (event: Prisma.LogEvent) =>
    logger.warn({ prisma: safeErrorMessage(event) }, 'prisma warning'),
  );
  client.$on('error' as never, (event: Prisma.LogEvent) =>
    logger.error({ prisma: safeErrorMessage(event) }, 'prisma error'),
  );
  client.$on('query' as never, (event: Prisma.LogEvent) =>
    logger.debug({ prisma: safeErrorMessage(event) }, 'prisma query'),
  );

  return client;
}

/**
 * Process-wide singleton used by the running server.
 *
 * `globalThis` caching matters in development: `tsx watch` re-evaluates modules on
 * every reload, and without it each reload would leak another connection pool
 * until Postgres refuses new clients.
 */
const globalForPrisma = globalThis as unknown as { seatrushPrisma?: PrismaClient };

export function getPrisma(config: AppConfig, logger: Logger): PrismaClient {
  globalForPrisma.seatrushPrisma ??= createPrismaClient(config, logger);
  return globalForPrisma.seatrushPrisma;
}

/** True when a Prisma error means "unique constraint violated" (our double-booking guard). */
export function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * Runs the cheapest possible query to prove the database is reachable and able to
 * answer. Never throws: a failed probe is data, not an exception, because the
 * health endpoint must report on both dependencies in one response.
 */
export async function probePostgres(
  prisma: PrismaClient,
  timeoutMs: number,
): Promise<DependencyHealth> {
  const startedAt = performance.now();
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, timeoutMs, 'Postgres probe timed out');
    return { status: DEPENDENCY_STATUS.UP, latencyMs: elapsedMs(startedAt) };
  } catch (error) {
    return {
      status: DEPENDENCY_STATUS.DOWN,
      latencyMs: elapsedMs(startedAt),
      error: safeErrorMessage(error),
    };
  }
}

function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}
