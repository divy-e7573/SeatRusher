import type {
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import { pino, type Logger } from 'pino';
import type { AppConfig } from './env.js';

/** Emitted on every log line so logs from several services stay separable. */
export const SERVICE_NAME = 'seatrush-api';

/**
 * The Fastify instance type produced when a concrete pino logger is supplied.
 *
 * Fastify's bare `FastifyInstance` alias defaults its Logger parameter to
 * `FastifyBaseLogger`, which is *wider* than pino's `Logger`, so an instance built
 * with `loggerInstance` is not assignable to it. Naming the shape once here keeps
 * that detail in a single place instead of leaking into every module signature.
 */
export type SeatrushFastifyInstance = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression<RawServerDefault>,
  RawReplyDefaultExpression<RawServerDefault>,
  Logger
>;

/**
 * Builds the process-wide structured logger.
 *
 * JSON (one object per line) is the default because that is what log shippers and
 * jq expect. Human-friendly output is opt-in via LOG_PRETTY and defaults to on
 * only in development; tests always get JSON so output stays machine-readable.
 */
export function createLogger(config: AppConfig): Logger {
  const usePretty = config.logPretty ?? config.nodeEnv === 'development';

  if (!usePretty) {
    return pino({ level: config.logLevel, base: { service: SERVICE_NAME } });
  }

  return pino({
    level: config.logLevel,
    base: { service: SERVICE_NAME },
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
        ignore: 'pid,hostname,service',
        singleLine: false,
      },
    },
  });
}
