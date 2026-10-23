import type { FastifyReply, FastifyRequest } from 'fastify';
import { ERROR_CODE_AUTH } from 'shared';
import { AppError } from '../../lib/errors.js';
import type { AuthService } from './auth-service.js';
import type { TokenIssuer } from './tokens.js';

export interface AuthenticatedUser {
  userId: string;
  email: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Present only after requireAuth has run. */
    currentUser?: AuthenticatedUser;
  }

  interface FastifyInstance {
    /** Registered in app.ts. Use as `preHandler: app.requireAuth` on protected routes. */
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * Builds the reusable `requireAuth` preHandler.
 *
 * Phase 2 has no protected business routes yet, but Phase 3 (holds) and Phase 6
 * (checkout) need exactly this. Registering it once here means those phases add a
 * single option rather than re-implementing token parsing.
 *
 * Usage on a route:
 *   fastify.get('/private', { preHandler: app.requireAuth }, handler)
 */
export function createRequireAuth(tokens: TokenIssuer, service: AuthService) {
  return async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new AppError('Missing bearer token', ERROR_CODE_AUTH.UNAUTHORIZED, 401);
    }

    try {
      const claims = await tokens.verifyAccessToken(header.slice('Bearer '.length).trim());
      request.currentUser = claims;
    } catch (error) {
      throw service.toUnauthorized(error);
    }
  };
}
