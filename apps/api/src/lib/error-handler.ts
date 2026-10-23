import { Prisma } from '@prisma/client';
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

  // Prisma surfaces database rule violations as typed errors. P2002 means some
  // unique index rejected a write. The double-booking guard is the expected case
  // in this system (AGENTS.md: seat conflict = 409); anything else is still a
  // genuine client conflict, but gets a distinct code so it is not mistaken for
  // a seat race.
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    const target = readUniqueTarget(error);
    if (target?.includes('booking_seats')) {
      return new AppError('Seat conflict: the seat is already booked', 'SEAT_CONFLICT', 409);
    }
    return new AppError('A record with these values already exists', 'UNIQUE_CONSTRAINT', 409);
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

/** Reads Prisma's `meta.target` without trusting its shape (it is string | object). */
function readUniqueTarget(error: Prisma.PrismaClientKnownRequestError): string | null {
  const meta = error.meta as { target?: unknown } | undefined;
  if (typeof meta?.target === 'string') {
    return meta.target;
  }
  if (Array.isArray(meta?.target)) {
    return meta.target.filter((part): part is string => typeof part === 'string').join(',');
  }
  return null;
}
