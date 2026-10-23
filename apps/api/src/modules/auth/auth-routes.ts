import type { FastifyPluginAsync } from 'fastify';
import type { z } from 'zod';
import {
  ERROR_CODE_AUTH,
  loginRequestSchema,
  registerRequestSchema,
  type AuthResponse,
} from 'shared';
import type { AppConfig } from '../../lib/env.js';
import { AppError, ValidationError } from '../../lib/errors.js';
import type { AuthService, IssuedAuth } from './auth-service.js';
import { REFRESH_COOKIE_NAME, clearRefreshCookie, setRefreshCookie } from './cookie.js';

export interface AuthRoutesOptions {
  service: AuthService;
  config: AppConfig;
}

/** Strips the internal refresh token: it travels in the cookie, never the body. */
function toResponse(issued: IssuedAuth): AuthResponse {
  return {
    user: issued.user,
    accessToken: issued.accessToken,
    expiresInSeconds: issued.expiresInSeconds,
    tokenType: issued.tokenType,
  };
}

/** Validates a request body, converting any zod failure into our standard 400. */
function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const detail = result.error.issues.map((issue) => issue.message).join(', ');
    throw new ValidationError(`Invalid request body: ${detail}`);
  }
  return result.data;
}

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (fastify, options) => {
  const { service, config } = options;

  fastify.post(
    '/auth/register',
    { config: { rateLimit: authRateLimit(config) } },
    async (request, reply) => {
      const body = parseBody(registerRequestSchema, request.body);
      const issued = await service.register(body);
      setRefreshCookie(reply, issued.refreshToken, config);
      return reply.code(201).send(toResponse(issued));
    },
  );

  fastify.post(
    '/auth/login',
    { config: { rateLimit: authRateLimit(config) } },
    async (request, reply) => {
      const body = parseBody(loginRequestSchema, request.body);
      const issued = await service.login(body);
      setRefreshCookie(reply, issued.refreshToken, config);
      return toResponse(issued);
    },
  );

  fastify.post(
    '/auth/refresh',
    { config: { rateLimit: authRateLimit(config) } },
    async (request, reply) => {
      const token = request.cookies[REFRESH_COOKIE_NAME];
      if (!token) {
        throw new AppError('No refresh token provided', ERROR_CODE_AUTH.UNAUTHORIZED, 401);
      }
      const issued = await service.refresh(token);
      setRefreshCookie(reply, issued.refreshToken, config);
      return toResponse(issued);
    },
  );

  /** Clears the cookie so the browser stops sending it. Server-side revocation of
   *  the session row is intentionally deferred: Phase 2 has no logout requirement
   *  in the PRD, and the reuse-detection rule already kills stolen tokens. */
  fastify.post('/auth/logout', async (_request, reply) => {
    clearRefreshCookie(reply, config);
    return reply.code(204).send();
  });
};

/** Per-route rate limit, read from validated env so operators can tune it. */
function authRateLimit(config: AppConfig) {
  return { max: config.authRateLimit.max, timeWindow: config.authRateLimit.windowMs };
}
