import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { createHoldRequestSchema } from 'shared';
import { ValidationError } from '../../lib/errors.js';
import type { HoldsService } from './holds-service.js';

/**
 * Authenticated seat-hold endpoints.
 *
 * Every route carries preHandler: app.requireAuth, and every handler reads the
 * user id from request.currentUser - never from the body, query or params. A
 * client-supplied userId would let anyone hold or release seats as somebody
 * else, so the type simply has no field to carry one.
 */

export interface HoldsRoutesOptions {
  service: HoldsService;
  /** Per-user/IP rate limit; FR-8 protects holds from burst abuse. */
  rateLimit: { max: number; windowMs: number };
}

/**
 * Throws when requireAuth did not populate currentUser. That would mean the
 * route was registered without the preHandler, which is a wiring bug worth
 * failing loudly on rather than holding seats for nobody.
 */
function authenticatedUserId(request: FastifyRequest): string {
  const userId = request.currentUser?.userId;
  if (!userId) {
    throw new ValidationError('Authentication is required for seat holds');
  }
  return userId;
}

function parseUuid(value: string, label: string): string {
  const parsed = createHoldRequestSchema.shape.seatIds.element.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(`Invalid ${label}: must be a valid UUID`);
  }
  return parsed.data;
}

export const holdsRoutes: FastifyPluginAsync<HoldsRoutesOptions> = async (
  fastify,
  options: HoldsRoutesOptions,
) => {
  const { service, rateLimit } = options;

  /**
   * Keyed by the authenticated user when available, falling back to IP. One
   * noisy user then cannot exhaust the quota of everyone behind the same NAT.
   */
  const holdRateLimit = {
    max: rateLimit.max,
    timeWindow: rateLimit.windowMs,
    keyGenerator: (request: FastifyRequest) => request.currentUser?.userId ?? request.ip,
  };

  fastify.post<{ Params: { id: string } }>(
    '/shows/:id/holds',
    { preHandler: fastify.requireAuth, config: { rateLimit: holdRateLimit } },
    async (request, reply: FastifyReply) => {
      const parsed = createHoldRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError(
          `Invalid request body: ${parsed.error.issues.map((issue) => issue.message).join(', ')}`,
        );
      }

      const hold = await service.createHold({
        showId: parseUuid(request.params.id, 'show id'),
        seatIds: parsed.data.seatIds,
        userId: authenticatedUserId(request),
      });

      return reply.code(201).send(hold);
    },
  );

  fastify.delete<{ Params: { holdId: string } }>(
    '/holds/:holdId',
    { preHandler: fastify.requireAuth, config: { rateLimit: holdRateLimit } },
    async (request, reply: FastifyReply) => {
      await service.releaseHold(
        parseUuid(request.params.holdId, 'hold id'),
        authenticatedUserId(request),
      );
      return reply.code(204).send();
    },
  );
};
