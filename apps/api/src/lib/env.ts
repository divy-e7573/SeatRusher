import { config as loadDotenvFile } from 'dotenv';
import { z } from 'zod';

export const NODE_ENVIRONMENTS = ['development', 'test', 'production'] as const;
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export type EnvSource = Record<string, string | undefined>;

export interface ConfigIssue {
  /** Dotted path of the offending variable, e.g. `DATABASE_URL`. */
  path: string;
  message: string;
}

/** Raised when the process environment does not describe a runnable service. */
export class ConfigError extends Error {
  readonly code = 'CONFIG_INVALID';
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    const details = issues.map((issue) => `  - ${issue.path}: ${issue.message}`).join('\n');
    super(`Invalid environment configuration:\n${details}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/**
 * Connection strings are validated with the WHATWG URL parser instead of a
 * hand-written regex, so postgres and redis parsing always follows the platform.
 */
function connectionString(protocols: readonly string[]) {
  return z
    .string()
    .min(1, 'must not be empty')
    .refine(
      (value) => {
        try {
          return protocols.includes(new URL(value).protocol);
        } catch {
          return false;
        }
      },
      `must be a connection string using one of: ${protocols.join(', ')}`,
    );
}

/**
 * A signing secret. Rejects short values and the obvious placeholder strings, so
 * a copy-pasted example value cannot reach production by accident.
 */
function secret() {
  return z
    .string()
    .min(32, 'must be at least 32 characters long')
    .refine(
      (value) => !/^(change[-_ ]?me|replace[-_ ]?me|example|secret|password)/i.test(value),
      'must not be a placeholder value',
    );
}

const rawEnvSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVIRONMENTS).default('development'),
  HOST: z.string().min(1, 'must not be empty').default('0.0.0.0'),
  PORT: z.coerce
    .number()
    .int('must be an integer')
    .min(1, 'must be >= 1')
    .max(65535, 'must be <= 65535')
    .default(4000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  LOG_PRETTY: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  DATABASE_URL: connectionString(['postgres:', 'postgresql:']),
  REDIS_URL: connectionString(['redis:', 'rediss:']),
  HEALTH_CHECK_TIMEOUT_MS: z.coerce
    .number()
    .int('must be an integer')
    .min(100, 'must be >= 100')
    .max(30_000, 'must be <= 30000')
    .default(2000),

  // --- Authentication (Phase 2) -------------------------------------------
  // Secrets must be long and random. They are validated for a minimum length so a
  // weak value fails at startup rather than silently signing forgeable tokens.
  JWT_ACCESS_SECRET: secret(),
  JWT_REFRESH_SECRET: secret(),
  JWT_ISSUER: z.string().min(1, 'must not be empty').default('seatrush-api'),
  JWT_ACCESS_TTL_SECONDS: z.coerce
    .number()
    .int('must be an integer')
    .min(60, 'must be >= 60')
    .max(3600, 'must be <= 3600')
    .default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce
    .number()
    .int('must be an integer')
    .min(300, 'must be >= 300')
    .max(2_592_000, 'must be <= 2592000')
    .default(604800),
  // Cookie `Secure` flag. MUST be true in production (the cookie then only travels
  // over HTTPS). Left unset it is derived from NODE_ENV.
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  AUTH_RATE_LIMIT_MAX: z.coerce
    .number()
    .int('must be an integer')
    .min(1, 'must be >= 1')
    .max(10_000)
    .default(20),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int('must be an integer')
    .min(1000, 'must be >= 1000')
    .default(60_000),
});

const envSchema = rawEnvSchema.transform((env) => ({
  nodeEnv: env.NODE_ENV,
  host: env.HOST,
  port: env.PORT,
  logLevel: env.LOG_LEVEL,
  // When unset, the logger decides from NODE_ENV.
  logPretty: env.LOG_PRETTY,
  databaseUrl: env.DATABASE_URL,
  redisUrl: env.REDIS_URL,
  healthCheckTimeoutMs: env.HEALTH_CHECK_TIMEOUT_MS,
  jwt: {
    accessSecret: env.JWT_ACCESS_SECRET,
    refreshSecret: env.JWT_REFRESH_SECRET,
    issuer: env.JWT_ISSUER,
    accessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
    refreshTtlSeconds: env.JWT_REFRESH_TTL_SECONDS,
  },
  /** Undefined means "derive from NODE_ENV": secure in production only. */
  cookieSecure: env.COOKIE_SECURE,
  authRateLimit: {
    max: env.AUTH_RATE_LIMIT_MAX,
    windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  },
}));

/** Fully validated, camel-cased configuration consumed by the rest of the app. */
export type AppConfig = z.infer<typeof envSchema>;

/**
 * Pure function: validates a raw environment bag without touching `process.env`,
 * which keeps configuration behaviour directly unit-testable.
 */
export function parseConfig(source: EnvSource): AppConfig {
  const result = envSchema.safeParse(source);
  if (result.success) {
    return result.data;
  }

  const issues: ConfigIssue[] = result.error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.map((segment) => String(segment)).join('.') : '(root)',
    message: issue.message,
  }));
  throw new ConfigError(issues);
}

/**
 * Loads `apps/api/.env` (when present) and then validates the result.
 * dotenv never overwrites variables that already exist in the environment, so CI
 * and container runtimes keep taking precedence over the local file.
 */
export function loadConfig(): AppConfig {
  loadDotenvFile({ quiet: true });
  return parseConfig(process.env);
}
