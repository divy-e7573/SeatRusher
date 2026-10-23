import type { FastifyReply } from 'fastify';
import type { AppConfig } from '../../lib/env.js';

/**
 * Refresh-token cookie policy, in one place so every set and clear agrees.
 *
 * Flags:
 * - `httpOnly`  : JavaScript cannot read it, so an XSS bug cannot steal it.
 * - `sameSite`  : 'strict' stops the browser sending it on cross-site requests
 *                 (CSRF defence for a token that authorises account access).
 * - `secure`    : HTTPS-only. Defaults to on in production; forced OFF in
 *                 development because plain-HTTP localhost silently DROPS
 *                 Secure cookies, which would break local testing.
 * - `path`      : scoped to /auth so the cookie is not attached to every request.
 */
export const REFRESH_COOKIE_NAME = 'seatrush_refresh';

const REFRESH_COOKIE_PATH = '/auth';

export function isCookieSecure(config: AppConfig): boolean {
  return config.cookieSecure ?? config.nodeEnv === 'production';
}

export function setRefreshCookie(reply: FastifyReply, token: string, config: AppConfig): void {
  reply.setCookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: isCookieSecure(config),
    path: REFRESH_COOKIE_PATH,
    maxAge: config.jwt.refreshTtlSeconds,
  });
}

export function clearRefreshCookie(reply: FastifyReply, config: AppConfig): void {
  reply.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'strict',
    secure: isCookieSecure(config),
    path: REFRESH_COOKIE_PATH,
  });
}
