import { pino } from 'pino';
import { buildServer } from './app.js';
import { ConfigError, loadConfig } from './lib/env.js';
import { createLogger } from './lib/logger.js';
import { createPostgresPool } from './lib/postgres.js';
import { createRedisClient } from './lib/redis.js';

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
  const postgres = createPostgresPool(config);
  // lazyConnect: constructing the client does not open a socket, so a Redis outage
  // never prevents the API from starting. /health reports the outage instead.
  const redis = createRedisClient(config);

  const app = buildServer({ config, postgres, redis });

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
        await postgres.end();
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
