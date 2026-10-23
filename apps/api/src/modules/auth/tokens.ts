import { createHash, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

export interface AccessTokenClaims {
  userId: string;
  email: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface TokenIssuerOptions {
  accessSecret: string;
  refreshSecret: string;
  issuer: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
}

/** Why a token was rejected. Mapped to HTTP status by the service layer. */
export class TokenError extends Error {
  readonly reason: 'expired' | 'invalid';

  constructor(reason: 'expired' | 'invalid', message: string) {
    super(message);
    this.name = 'TokenError';
    this.reason = reason;
  }
}

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export function createTokenIssuer(options: TokenIssuerOptions) {
  const accessKey = secretKey(options.accessSecret);
  const refreshKey = secretKey(options.refreshSecret);

  return {
    /**
     * Access token: short-lived, signed with the ACCESS secret only. It is
     * self-contained, so verifying a request needs no database round trip.
     */
    async issueAccessToken(claims: AccessTokenClaims): Promise<string> {
      return (
        new SignJWT({ email: claims.email })
          .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
          .setSubject(claims.userId)
          // A random jti makes every token unique. Without it, two tokens minted for
          // the same user inside the same second are byte-identical (same iat, sub,
          // issuer) and would collide on the unique refresh_token_hash index.
          .setJti(randomUUID())
          .setIssuer(options.issuer)
          .setIssuedAt()
          .setExpirationTime(`${options.accessTtlSeconds}s`)
          .sign(accessKey)
      );
    },

    /**
     * Refresh token: long-lived, signed with a DIFFERENT secret. Using a separate
     * key means a leaked refresh secret cannot be used to mint access tokens, and
     * vice versa.
     */
    async issueRefreshToken(userId: string): Promise<string> {
      return new SignJWT({ tokenType: 'refresh' })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(userId)
        .setJti(randomUUID())
        .setIssuer(options.issuer)
        .setIssuedAt()
        .setExpirationTime(`${options.refreshTtlSeconds}s`)
        .sign(refreshKey);
    },

    async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
      const result = await this.verify(token, accessKey);
      const email = result.payload['email'];
      if (typeof result.payload.sub !== 'string' || typeof email !== 'string') {
        throw new TokenError('invalid', 'Access token is missing required claims');
      }
      return { userId: result.payload.sub, email };
    },

    async verifyRefreshToken(token: string): Promise<{ userId: string }> {
      const result = await this.verify(token, refreshKey);
      if (typeof result.payload.sub !== 'string' || result.payload['tokenType'] !== 'refresh') {
        throw new TokenError('invalid', 'Refresh token is malformed');
      }
      return { userId: result.payload.sub };
    },

    async verify(token: string, key: Uint8Array) {
      try {
        return await jwtVerify(token, key, { issuer: options.issuer });
      } catch (error) {
        if (error instanceof Error && error.name === 'JWTExpired') {
          throw new TokenError('expired', 'Token has expired');
        }
        // Never echo the token or the underlying message: it can contain the
        // signed payload, which is a secret-adjacent value.
        throw new TokenError('invalid', 'Token could not be verified');
      }
    },

    accessTtlSeconds: options.accessTtlSeconds,
    refreshTtlSeconds: options.refreshTtlSeconds,
  };
}

export type TokenIssuer = ReturnType<typeof createTokenIssuer>;

/**
 * SHA-256 of a refresh token, stored in Postgres in place of the token itself.
 *
 * A plain hash (not bcrypt/argon2) is correct here: the input is already a
 * high-entropy random token, so there is nothing to brute force, and the lookup
 * must be a fast indexed equality check.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
