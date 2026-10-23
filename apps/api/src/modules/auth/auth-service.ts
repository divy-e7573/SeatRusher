import { Prisma } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import {
  ERROR_CODE_AUTH,
  type AuthResponse,
  type LoginRequest,
  type PublicUser,
  type RegisterRequest,
} from 'shared';
import { AppError } from '../../lib/errors.js';
import { hashPassword, verifyPassword } from './password.js';
import { hashRefreshToken, TokenError, type TokenIssuer } from './tokens.js';
import type { AuthRepository, UserRecord } from './auth-repository.js';

/**
 * Authentication business rules.
 *
 * Deliberately free of HTTP concerns: it returns data and throws AppError, and
 * the route layer maps that onto status codes and cookies.
 */

export interface AuthServiceDeps {
  repository: AuthRepository;
  tokens: TokenIssuer;
  logger: FastifyBaseLogger;
  /** Server clock. Injectable so expiry can be tested without waiting. */
  now?: () => Date;
}

export interface IssuedAuth extends AuthResponse {
  /** Plain refresh token: returned to the route, which sets the cookie. */
  refreshToken: string;
}

function toPublicUser(user: UserRecord): PublicUser {
  return { id: user.id, email: user.email, displayName: user.displayName };
}

export function createAuthService({
  repository,
  tokens,
  logger,
  now = () => new Date(),
}: AuthServiceDeps) {
  /** Issues a fresh access+refresh pair and persists the refresh token's hash. */
  async function issueSession(user: UserRecord): Promise<IssuedAuth> {
    const refreshToken = await tokens.issueRefreshToken(user.id);
    const expiresAt = new Date(now().getTime() + tokens.refreshTtlSeconds * 1000);

    await repository.createSession({
      userId: user.id,
      refreshTokenHash: hashRefreshToken(refreshToken),
      expiresAt,
    });

    return {
      user: toPublicUser(user),
      accessToken: await tokens.issueAccessToken({ userId: user.id, email: user.email }),
      expiresInSeconds: tokens.accessTtlSeconds,
      tokenType: 'Bearer',
      refreshToken,
    };
  }

  return {
    async register(input: RegisterRequest): Promise<IssuedAuth> {
      const passwordHash = await hashPassword(input.password);

      let user: UserRecord;
      try {
        user = await repository.createUser({
          email: input.email,
          passwordHash,
          displayName: input.displayName,
        });
      } catch (error) {
        // users_email_key is a PLAIN unique index (verified in schema + migration),
        // so P2002 here can only mean the email is taken. Log the address: it is a
        // registration attempt, not a secret, and it is invaluable for support.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          logger.info({ email: input.email }, 'registration rejected: email already registered');
          throw new AppError(
            'An account with this email already exists',
            ERROR_CODE_AUTH.EMAIL_ALREADY_EXISTS,
            409,
          );
        }
        throw error;
      }

      logger.info({ userId: user.id }, 'user registered');
      return issueSession(user);
    },

    async login(input: LoginRequest): Promise<IssuedAuth> {
      const user = await repository.findUserByEmail(input.email);

      // Always run a hash verification, even when the user does not exist, so the
      // response time does not reveal whether an email is registered. Without this,
      // a missing user returns instantly and a real one takes ~100ms of Argon2.
      const hashToCheck = user?.passwordHash ?? DUMMY_HASH;
      const passwordOk = await verifyPassword(hashToCheck, input.password);

      // One identical error for both cases: never confirm that an email exists.
      if (!user || !passwordOk) {
        logger.info({ email: input.email }, 'login failed');
        throw new AppError('Invalid email or password', ERROR_CODE_AUTH.INVALID_CREDENTIALS, 401);
      }

      logger.info({ userId: user.id }, 'login succeeded');
      return issueSession(user);
    },

    /**
     * Rotates a refresh token.
     *
     * Normal path: verify signature -> find the session -> revoke it -> issue a new
     * pair. The old token is dead the moment a new one exists, so a stolen old token
     * has a very small window.
     *
     * Reuse path: a REVOKED token was presented. That means the token leaked and two
     * parties hold it, so every active session for the user is revoked to contain
     * the damage. The legitimate user is logged out and must log in again.
     */
    async refresh(refreshToken: string): Promise<IssuedAuth> {
      let userId: string;
      try {
        ({ userId } = await tokens.verifyRefreshToken(refreshToken));
      } catch (error) {
        throw this.toUnauthorized(error);
      }

      const session = await repository.findSessionByTokenHash(hashRefreshToken(refreshToken));

      if (!session) {
        // Valid signature but no session row: the session was deleted outright.
        throw new AppError('Invalid or expired session', ERROR_CODE_AUTH.UNAUTHORIZED, 401);
      }

      if (session.revokedAt !== null) {
        const revokedCount = await repository.revokeAllActiveSessionsForUser(session.userId);
        logger.warn(
          { userId: session.userId, revokedSessions: revokedCount },
          'refresh token reuse detected: revoked all active sessions for the user',
        );
        throw new AppError(
          'Refresh token reuse detected; all sessions have been revoked',
          ERROR_CODE_AUTH.UNAUTHORIZED,
          401,
        );
      }

      if (session.expiresAt.getTime() <= now().getTime()) {
        await repository.revokeSession(session.id);
        throw new AppError('Session expired', ERROR_CODE_AUTH.UNAUTHORIZED, 401);
      }

      const user = await repository.findUserById(userId);
      if (!user) {
        throw new AppError('Invalid or expired session', ERROR_CODE_AUTH.UNAUTHORIZED, 401);
      }

      // Rotate: the presented token dies, a new one is issued and stored.
      await repository.revokeSession(session.id);
      logger.info({ userId: user.id }, 'refresh token rotated');
      return issueSession(user);
    },

    /** Shared mapping for every token verification failure. */
    toUnauthorized(error: unknown): AppError {
      if (error instanceof TokenError) {
        return new AppError(
          error.reason === 'expired' ? 'Session expired, please log in again' : 'Invalid token',
          ERROR_CODE_AUTH.UNAUTHORIZED,
          401,
        );
      }
      return new AppError('Invalid token', ERROR_CODE_AUTH.UNAUTHORIZED, 401);
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;

/**
 * A real Argon2id hash of a random string, used only to equalise login timing when
 * the email does not exist. It is never stored and never compared against a user.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$T6KBSWDbmNXRYIPGe8R8GQ$SgxNkyJy5Y7R6aG0qJmQ30TDjMrHASjX2mja60FWonc';
