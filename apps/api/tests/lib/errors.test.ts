import { describe, expect, it } from 'vitest';
import {
  AppError,
  NotFoundError,
  safeErrorMessage,
  toErrorResponse,
  ValidationError,
} from '../../src/lib/errors.js';

describe('safeErrorMessage', () => {
  it('redacts postgres credentials so they never reach a log line', () => {
    const message = safeErrorMessage(
      new Error('connection to postgres://seatrush:super-secret@localhost:5432/seatrush failed'),
    );

    expect(message).not.toContain('super-secret');
    expect(message).toContain('postgres://[redacted]');
  });

  it('redacts redis credentials too', () => {
    const message = safeErrorMessage(new Error('auth failed for redis://:letmein@cache:6379'));
    expect(message).not.toContain('letmein');
  });

  it('truncates very long messages so log lines stay readable', () => {
    const message = safeErrorMessage(new Error('x'.repeat(1000)));
    expect(message.length).toBeLessThanOrEqual(303);
    expect(message.endsWith('...')).toBe(true);
  });

  it('handles values that are not Error instances', () => {
    expect(safeErrorMessage('plain string failure')).toBe('plain string failure');
  });
});

describe('toErrorResponse', () => {
  it('keeps the code and message of a deliberate AppError', () => {
    const body = toErrorResponse(new NotFoundError('Show 42 not found'), 'req-1');
    expect(body).toEqual({
      error: { code: 'NOT_FOUND', message: 'Show 42 not found', requestId: 'req-1' },
    });
  });

  it('maps validation failures to BAD_REQUEST', () => {
    const body = toErrorResponse(new ValidationError('seatIds must be an array'), 'req-2');
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('hides the message of an unexpected error behind a generic 500 body', () => {
    const body = toErrorResponse(new Error('ENOENT: /etc/secrets/key.pem'), 'req-3');
    expect(body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: 'req-3' },
    });
  });

  it('exposes statusCode on AppError for the HTTP layer', () => {
    expect(new NotFoundError('nope').statusCode).toBe(404);
    expect(new AppError('boom', 'BOOM', 503).statusCode).toBe(503);
  });
});
