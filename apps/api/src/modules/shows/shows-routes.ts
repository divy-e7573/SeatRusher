import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../lib/errors.js';
import type { ShowsService } from './shows-service.js';

/**
 * Read-only show endpoints. Routes only validate input and delegate: every
 * decision (404 vs 200, cache hit vs miss) belongs to the service.
 */

/** Show ids are UUIDs; anything else is a client error, not a 404 hunt. */
const showIdParams = z.object({ id: z.string().uuid('must be a valid UUID') });

export interface ShowsRoutesOptions {
  service: ShowsService;
}

function parseShowId(params: unknown): string {
  const result = showIdParams.safeParse(params);
  if (!result.success) {
    throw new ValidationError(
      `Invalid show id: ${result.error.issues.map((issue) => issue.message).join(', ')}`,
    );
  }
  return result.data.id;
}

export const showsRoutes: FastifyPluginAsync<ShowsRoutesOptions> = async (fastify, options) => {
  fastify.get('/shows', async () => {
    return { shows: await options.service.listShows() };
  });

  fastify.get('/shows/:id', async (request) => {
    return options.service.getShowDetail(parseShowId(request.params));
  });

  fastify.get('/shows/:id/seats', async (request) => {
    return options.service.getShowSeats(parseShowId(request.params));
  });
};
