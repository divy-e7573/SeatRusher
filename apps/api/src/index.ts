import { pino } from 'pino';
import { buildServer } from './app.js';
import { ConfigError, loadConfig } from './lib/env.js';
import { safeErrorMessage } from './lib/errors.js';
import { createLogger } from './lib/logger.js';
import { getPrisma } from './lib/prisma.js';
import { createRedisClient, ensureRedisConnected } from './lib/redis.js';

/** Used only before config validation succeeds, so real failures are still structured. */
const bootstrapLogger = pino({ level: 'error' });

const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      bootstrapLogger.error(
        { issues: error.issues },
        'Cannot start: invalid environment configuration. Copy apps/api/.env.example to apps/api/.env and fix the listed variables.',
      );
    } else {
      bootstrapLogger.error({ err: error }, 'Cannot start: configuration could not be loaded');
    }
    process.exit(1);
  }

  const logger = createLogger(config);
  // Prisma connects lazily, so a database outage cannot stop the API from
  // booting; /health reports the outage instead.
  const prisma = getPrisma(config, logger);
  // lazyConnect: constructing the client does not open a socket, so a Redis outage
  // never prevents the API from starting. /health reports the outage instead.
  const redis = createRedisClient(config);

  // Best-effort eager connect so the first request does not pay the connection
  // cost. A failure here is not fatal: /health will report the outage (invariant 9
  // means holds are rejected when Redis is down, not that the API refuses to boot).
  await ensureRedisConnected(redis).catch((error: unknown) => {
    logger.warn(
      { err: safeErrorMessage(error) },
      'Redis is not reachable at startup; /health will report it',
    );
  });

  const app = buildServer({ config, prisma, redis });

  await app.listen({ host: config.host, port: config.port });
  logger.info(
    { host: config.host, port: config.port, nodeEnv: config.nodeEnv },
    'SeatRush API is listening',
  );

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'Shutdown requested');

    const forceTimer = setTimeout(() => {
      logger.error('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref();

    void (async () => {
      try {
        // Stop accepting requests, then release both clients so no socket is leaked.
        await app.close();
        await redis.quit().catch(() => redis.disconnect());
        await prisma.$disconnect();
        logger.info('Shutdown complete');
      } catch (error) {
        logger.error({ err: error }, 'Error during shutdown');
        process.exitCode = 1;
      } finally {
        clearTimeout(forceTimer);
      }
    })();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  bootstrapLogger.fatal({ err: error }, 'Fatal error during startup');
  process.exit(1);
});
