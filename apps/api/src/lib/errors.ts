import { ERROR_CODE, type ErrorResponseBody } from 'shared';

/**
 * Base class for every error the API deliberately surfaces to clients.
 * Anything that is *not* an AppError is treated as an unexpected failure and its
 * message is replaced by a generic one before it leaves the process.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, code: string, statusCode: number) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** The requested route does not exist. Maps to HTTP 404. */
export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, ERROR_CODE.NOT_FOUND, 404);
    this.name = 'NotFoundError';
  }
}

/** Client input failed validation. Maps to HTTP 400. */
export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, ERROR_CODE.BAD_REQUEST, 400);
    this.name = 'ValidationError';
  }
}

const CONNECTION_STRING_PATTERN = /\b(postgres(?:ql)?|redis(?:s)?):\/\/[^\s"'<>]+/gi;

/**
 * Turns an unknown thrown value into a short, log-safe string.
 * Connection strings are redacted because they embed passwords, and AGENTS.md
 * forbids secrets from ever reaching a log sink.
 */
export function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = raw.replace(
    CONNECTION_STRING_PATTERN,
    (_match, scheme: string) => `${scheme}://[redacted]`,
  );
  return redacted.length > 300 ? `${redacted.slice(0, 300)}...` : redacted;
}

/** Builds the single error envelope used by every failing response. */
export function toErrorResponse(error: unknown, requestId: string): ErrorResponseBody {
  if (error instanceof AppError) {
    return { error: { code: error.code, message: error.message, requestId } };
  }
  return {
    error: { code: ERROR_CODE.INTERNAL_ERROR, message: 'Internal server error', requestId },
  };
}
