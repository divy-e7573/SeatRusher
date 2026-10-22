/**
 * Health contract shared by the API and any future consumers (web dashboard, k6).
 * Keeping it in `shared` means the shape cannot drift between producer and consumer.
 */

/** Overall verdict of the health check. */
export const HEALTH_STATUS = {
  /** Every dependency answered. */
  OK: 'ok',
  /** At least one dependency is unreachable; the process is alive but not usable. */
  DEGRADED: 'degraded',
} as const;

export type HealthStatus = (typeof HEALTH_STATUS)[keyof typeof HEALTH_STATUS];

/** Result of probing a single dependency. */
export const DEPENDENCY_STATUS = {
  UP: 'up',
  DOWN: 'down',
} as const;

export type DependencyStatus = (typeof DEPENDENCY_STATUS)[keyof typeof DEPENDENCY_STATUS];

export interface DependencyHealth {
  status: DependencyStatus;
  /** Round-trip time of the probe, in whole milliseconds. */
  latencyMs: number;
  /** Short, non-sensitive failure reason. Only present when `status` is `down`. */
  error?: string;
}

export interface HealthResponseBody {
  status: HealthStatus;
  /** Service name, so multi-service logs stay readable. */
  service: string;
  /** Seconds since the HTTP server started. */
  uptimeSeconds: number;
  /** Server-generated ISO-8601 timestamp (never a client clock). */
  timestamp: string;
  checks: {
    postgres: DependencyHealth;
    redis: DependencyHealth;
  };
}
