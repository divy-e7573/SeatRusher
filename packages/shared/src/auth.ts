import { z } from 'zod';

/**
 * Authentication contracts shared by the API and the web app.
 *
 * The API validates every request body with these exact schemas, and the web app
 * imports them to type its forms, so a field can never be spelled two ways.
 */

/** Password policy: long enough to matter, without arbitrary symbol rules. */
export const passwordSchema = z
  .string()
  .min(10, 'must be at least 10 characters')
  .max(128, 'must be at most 128 characters');

/** Emails are compared and stored lowercase so `A@x.com` and `a@x.com` are one user. */
export const emailSchema = z
  .string()
  .min(3, 'must not be empty')
  .max(254, 'must be at most 254 characters')
  .email('must be a valid email address')
  .transform((value) => value.trim().toLowerCase());

export const registerRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z
    .string()
    .trim()
    .min(1, 'must not be empty')
    .max(80, 'must be at most 80 characters'),
});

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'must not be empty').max(128, 'must be at most 128 characters'),
});

export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** The user shape returned by the API. Note what is ABSENT: passwordHash. */
export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
}

/** Response body of register and refresh. */
export interface AuthResponse {
  user: PublicUser;
  /** Short-lived; sent in the body so the client can call the API with it. */
  accessToken: string;
  /** Seconds until `accessToken` expires, so the client can refresh proactively. */
  expiresInSeconds: number;
  tokenType: 'Bearer';
}

export const ERROR_CODE_AUTH = {
  /** Email already registered, or seat-style conflict. */
  EMAIL_ALREADY_EXISTS: 'EMAIL_ALREADY_EXISTS',
  /** Wrong email or password. Deliberately identical for both, so the endpoint
   *  cannot be used to discover which emails are registered. */
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  /** Access or refresh token missing, malformed, expired or revoked. */
  UNAUTHORIZED: 'UNAUTHORIZED',
  /** Too many attempts from this IP. */
  RATE_LIMITED: 'RATE_LIMITED',
} as const;
