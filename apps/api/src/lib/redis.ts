import { Redis } from 'ioredis';
import { DEPENDENCY_STATUS, type DependencyHealth } from 'shared';
import type { AppConfig } from './env.js';
import { safeErrorMessage } from './errors.js';
import { withTimeout } from './timeout.js';

/**
 * Creates the Redis client used by the health probe and, later, by seat holds.
 *
 * `lazyConnect` means a Redis outage never blocks API startup: the process comes
 * up and /health reports the outage instead. `retryStrategy` is bounded, so the
 * client can ride out a transient blip but never spins forever holding the loop.
 */
export function createRedisClient(config: AppConfig): Redis {
  const client = new Redis(config.redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: config.healthCheckTimeoutMs,
    retryStrategy: (attempt) => (attempt > 3 ? null : Math.min(attempt * 200, 1000)),
  });

  // ioredis emits 'error' on every failed reconnect attempt. Without a listener
  // Node treats that as an unhandled error event and kills the process, so the
  // health endpoint stays the single place that decides how loud a failure is.
  client.on('error', () => {
    // Intentionally observed through probeRedis instead.
  });

  return client;
}

/**
 * Connects the lazy client on first use and memoises the in-flight attempt.
 *
 * With `lazyConnect`, every command issued before the first connection throws
 * `Stream isn't writeable`. Rather than connecting eagerly at boot (which would
 * make a Redis outage a startup problem), each subsystem that touches Redis
 * calls this first. Concurrent first calls share one connection attempt, and a
 * failed attempt is not cached so a later request can retry.
 */
export function ensureRedisConnected(client: Redis): Promise<void> {
  if (client.status === 'ready') {
    return Promise.resolve();
  }
  const pending = pendingConnects.get(client);
  if (pending) {
    return pending;
  }
  const attempt = client.connect().finally(() => {
    pendingConnects.delete(client);
  });
  pendingConnects.set(client, attempt);
  return attempt;
}

const pendingConnects = new WeakMap<Redis, Promise<void>>();

/**
 * Proves Redis is reachable with a PING, connecting first if the client is idle.
 * Never throws, for the same reason as probePostgres.
 */
export async function probeRedis(client: Redis, timeoutMs: number): Promise<DependencyHealth> {
  const startedAt = performance.now();
  try {
    await withTimeout(ensureRedisConnected(client), timeoutMs, 'Redis connect timed out');
    await withTimeout(client.ping(), timeoutMs, 'Redis probe timed out');
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
