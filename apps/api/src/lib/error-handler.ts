import type { FastifyReply, FastifyRequest } from 'fastify';
import { ERROR_CODE } from 'shared';
import { AppError, ValidationError, toErrorResponse } from './errors.js';
import type { SeatrushFastifyInstance } from './logger.js';

/**
 * Installs the single place where every failure becomes an HTTP response.
 * Keeping this in one function is what makes the `{ error: { code, message } }`
 * envelope from AGENTS.md a real guarantee rather than a convention.
 */
export function registerErrorHandlers(app: SeatrushFastifyInstance): void {
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const response = toErrorResponse(
      new AppError(`Route ${request.method}:${request.url} not found`, ERROR_CODE.NOT_FOUND, 404),
      request.id,
    );
    return reply.code(404).send(response);
  });

  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const normalised = normaliseError(error);
    const logFields = { err: error, requestId: request.id };

    if (normalised.statusCode >= 500) {
      request.log.error(logFields, 'request failed');
    } else {
      request.log.warn(logFields, 'request rejected');
    }

    return reply.code(normalised.statusCode).send(toErrorResponse(error, request.id));
  });
}

/**
 * Maps framework and validation errors onto AppError so the HTTP status code is
 * decided in exactly one place. Anything unrecognised stays a 500 and its message
 * is hidden from clients by `toErrorResponse`.
 */
function normaliseError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (isFastifyValidationError(error)) {
    return new ValidationError('Request validation failed');
  }

  const statusCode = extractStatusCode(error);
  return new AppError(
    statusCode >= 500 ? 'Internal server error' : 'Request failed',
    statusCode >= 500 ? ERROR_CODE.INTERNAL_ERROR : ERROR_CODE.BAD_REQUEST,
    statusCode,
  );
}

interface FastifyLikeError {
  statusCode?: unknown;
  validation?: unknown;
}

function isFastifyValidationError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'validation' in error &&
    Boolean((error as FastifyLikeError).validation)
  );
}

function extractStatusCode(error: unknown): number {
  if (typeof error !== 'object' || error === null) {
    return 500;
  }
  const candidate = (error as FastifyLikeError).statusCode;
  return typeof candidate === 'number' && candidate >= 400 && candidate <= 599 ? candidate : 500;
}
