import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../../src/lib/env.js';

/** A minimal, valid environment. Individual tests override single variables. */
function validEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    DATABASE_URL: 'postgres://seatrush:secret@localhost:5432/seatrush',
    REDIS_URL: 'redis://localhost:6379',
    ...overrides,
  };
}

describe('parseConfig', () => {
  it('parses a minimal valid environment and applies defaults', () => {
    const config = parseConfig(validEnv());

    expect(config.nodeEnv).toBe('development');
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(4000);
    expect(config.logLevel).toBe('info');
    expect(config.healthCheckTimeoutMs).toBe(2000);
    expect(config.logPretty).toBeUndefined();
  });

  it('coerces numeric strings coming from the environment', () => {
    const config = parseConfig(validEnv({ PORT: '8080', HEALTH_CHECK_TIMEOUT_MS: '750' }));

    expect(config.port).toBe(8080);
    expect(config.healthCheckTimeoutMs).toBe(750);
  });

  it('parses the optional LOG_PRETTY tri-state flag', () => {
    expect(parseConfig(validEnv({ LOG_PRETTY: 'true' })).logPretty).toBe(true);
    expect(parseConfig(validEnv({ LOG_PRETTY: 'false' })).logPretty).toBe(false);
    expect(parseConfig(validEnv()).logPretty).toBeUndefined();
  });

  it('accepts postgresql:// as an alias for postgres://', () => {
    const config = parseConfig(validEnv({ DATABASE_URL: 'postgresql://user:pw@db:5432/app' }));
    expect(config.databaseUrl).toBe('postgresql://user:pw@db:5432/app');
  });

  it('fails with a ConfigError when DATABASE_URL is missing', () => {
    expect(() => parseConfig(validEnv({ DATABASE_URL: undefined }))).toThrow(ConfigError);
  });

  it('reports every invalid variable in one error instead of failing one at a time', () => {
    let caught: unknown;
    try {
      parseConfig(
        validEnv({ DATABASE_URL: 'http://localhost:5432', REDIS_URL: undefined, PORT: 'abc' }),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    const issues = (caught as ConfigError).issues.map((issue) => issue.path);
    expect(issues).toContain('DATABASE_URL');
    expect(issues).toContain('REDIS_URL');
    expect(issues).toContain('PORT');
  });

  it('rejects a non-numeric PORT', () => {
    expect(() => parseConfig(validEnv({ PORT: 'not-a-number' }))).toThrow(ConfigError);
  });

  it('rejects an out-of-range PORT', () => {
    expect(() => parseConfig(validEnv({ PORT: '70000' }))).toThrow(ConfigError);
  });

  it('rejects a REDIS_URL with the wrong protocol', () => {
    expect(() => parseConfig(validEnv({ REDIS_URL: 'http://localhost:6379' }))).toThrow(
      ConfigError,
    );
  });

  it('rejects an unknown LOG_LEVEL', () => {
    expect(() => parseConfig(validEnv({ LOG_LEVEL: 'verbose' }))).toThrow(ConfigError);
  });

  it('never echoes a credential value back in the error message', () => {
    let caught: unknown;
    try {
      parseConfig(validEnv({ REDIS_URL: 'mysql://user:hunter2@localhost:3306/db' }));
    } catch (error) {
      caught = error;
    }

    expect((caught as Error).message).not.toContain('hunter2');
  });
});
