import { Pool } from 'pg';
import { DEPENDENCY_STATUS, type DependencyHealth } from 'shared';
import type { AppConfig } from './env.js';
import { safeErrorMessage } from './errors.js';
import { SERVICE_NAME } from './logger.js';
import { withTimeout } from './timeout.js';

/**
 * Creates the connection pool used by the health probe.
 *
 * Phase 0 deliberately talks to Postgres with the thin `pg` driver only: it is the
 * smallest thing that can prove connectivity. Prisma is introduced in Phase 1, and
 * everything downstream imports `Pool` rather than a concrete client, so swapping
 * the driver later touches this one file.
 */
export function createPostgresPool(config: AppConfig): Pool {
  return new Pool({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: config.healthCheckTimeoutMs,
    application_name: SERVICE_NAME,
    max: 10,
  });
}

/**
 * Runs the cheapest possible query to prove the database is reachable and able to
 * answer. Never throws: a failed probe is data, not an exception, because the
 * health endpoint must report on both dependencies in one response.
 */
export async function probePostgres(pool: Pool, timeoutMs: number): Promise<DependencyHealth> {
  const startedAt = performance.now();
  try {
    await withTimeout(pool.query('SELECT 1'), timeoutMs, 'Postgres probe timed out');
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
